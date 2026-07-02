/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

/*
 * inspect-traces.js - PCB net trace generation, caching and rendering for the
 * Inspect view, powered by the WireBender `PcbVisualizer` WASM API.
 *
 * Design notes
 * ════════════
 *	- Traces are routed ONCE in a single reference-image coordinate space using
 *	  one `PcbVisualizer.route()` call (for all nets initially). The resulting
 *	  polylines are cached in memory keyed by net id.
 *	- Rendering on every other PCB photo reuses the existing perspective
 *	  transform logic (homography projection) instead of recalculating traces
 *	  per view. This keeps the cost flat even with ~12 simultaneous views.
 *	- The cache lives on the Inspector instance, so it survives navigation
 *	  between tabs/views. Each net carries a content signature; when net data
 *	  changes the affected entries are transparently recomputed.
 */

/**
 * Code-level configuration (intentionally NOT exposed in the UI).
 */
const TraceConfig = {
	/** Stroke colour for the currently selected (active) net traces. */
	ACTIVE_TRACE_COLOR: '#f59e0b', // amber
	/** Stroke colour for all other (inactive) net traces. */
	INACTIVE_TRACE_COLOR: '#7dd3fc', // light sky cyan
	/** Wire stroke width (screen pixels, scale-compensated). */
	TRACE_WIDTH: 2.5,
	/** Junction rounding radius (screen pixels, scale-compensated). */
	JUNCTION_RADIUS: 10,
	/** Outer radius of a pin's copper pad (screen pixels, scale-compensated). */
	PAD_OUTER_RADIUS: 4,
	/** Radius of the drill hole punched out of the centre of each pad. */
	PAD_HOLE_RADIUS: 2.5,
	/**
	 * Global recalculation policy when any single net changes:
	 *	 'single' — recompute only the modified net (default, fastest).
	 *	 'all'	  — recompute every net (avoids cross-net routing conflicts).
	 */
	RECALC_MODE: 'single',
	/** WireBender WASM module entry point. */
	WASM_URL: 'https://dev-lab.github.io/WireBender/latest/WireBender.js',
	/** WireBender WASM binary. */
	WASM_BINARY_URL: 'https://dev-lab.github.io/WireBender/latest/WireBender.wasm',
};

/**
 * Computes a stable content signature for a net so the cache can detect any
 * routing-affecting modification (node add/remove/move, rename, ...).
 */
class NetSignature {
	/**
	 * @param net net record { id, name, nodes:[{id,imgId,x,y,label}] }
	 * @returns string signature
	 */
	static of(net) {
		const parts = [net.name || ''];
		const nodes = (net.nodes || []).slice().sort((a, b) => {
			const ka = (a.id || a.label || '') + '';
			const kb = (b.id || b.label || '') + '';
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		nodes.forEach(n => parts.push(`${n.id}:${n.imgId}:${n.x}:${n.y}:${n.label}`));
		return parts.join('|');
	}
}

/**
 * In-memory cache of generated traces, keyed by net id. Traces are stored in
 * the reference-image coordinate space and never persisted to DB/project files.
 */
class TraceCache {
	/**
	 * @param opts { recalcMode?, moduleLoader?, module? }
	 *	 moduleLoader — async () => WireBender Module (overridable for tests).
	 *	 module		  — pre-resolved WireBender Module (overridable for tests).
	 */
	constructor(opts = {}) {
		/** netId → { sig, name, wires:[[{x,y}]], junctions:[{x,y}], pads:[{x,y}] } (reference space). */
		this.entries = new Map();
		/** Reference image id the cached geometry belongs to. */
		this.refId = null;
		this.recalcMode = opts.recalcMode || TraceConfig.RECALC_MODE;
		this._moduleLoader = opts.moduleLoader || TraceCache.defaultModuleLoader;
		this._module = opts.module || null;
		/** Diagnostic counters (also used by tests). */
		this.stats = { routeCalls: 0, netsRouted: 0 };
	}

	/**
	 * Default loader: dynamically imports the WireBender WASM module.
	 * @returns Promise<Module>
	 */
	static async defaultModuleLoader() {
		const m = await import(TraceConfig.WASM_URL);
		return await m.default({
			locateFile: f => f === 'WireBender.wasm' ? TraceConfig.WASM_BINARY_URL : f,
		});
	}

	/** Lazily resolve and memoise the WASM module. */
	async _getModule() {
		if (!this._module) this._module = await this._moduleLoader();
		return this._module;
	}

	/** Drop the cached geometry for one net. */
	invalidate(netId) { this.entries.delete(netId); }

	/** Drop all cached geometry. */
	invalidateAll() { this.entries.clear(); }

	/** @returns cached entry { sig, name, wires, junctions } or undefined. */
	get(netId) { return this.entries.get(netId); }

	/**
	 * Ensure every net has up-to-date traces in the cache.
	 *
	 * Performs at most one `PcbVisualizer.route()` call. Nets whose signature
	 * is unchanged are reused; removed nets are pruned. In 'single' mode only
	 * changed nets are re-routed, in 'all' mode (or when forceAll is set) every
	 * net is re-routed together so cross-net conflicts are resolved globally.
	 *
	 * @param nets array of net records
	 * @param refId reference image id (coordinate space key)
	 * @param projectNodeToRef (node) => {x,y}|null — node native coords → ref space
	 * @param forceAll force a full recompute of all nets
	 * @returns Promise<boolean> whether any routing was performed
	 */
	async ensure(nets, refId, projectNodeToRef, forceAll = false) {
		if (this.refId !== refId) {
			this.invalidateAll();
			this.refId = refId;
			forceAll = true;
		}

		// Prune nets that no longer exist.
		const present = new Set(nets.map(n => n.id));
		for (const id of [...this.entries.keys()]) {
			if (!present.has(id)) this.entries.delete(id);
		}

		// Detect changed nets via signature.
		const changed = [];
		for (const net of nets) {
			const sig = NetSignature.of(net);
			const existing = this.entries.get(net.id);
			if (forceAll || !existing || existing.sig !== sig) changed.push(net);
		}
		if (changed.length === 0) return false;

		const routeSet = (this.recalcMode === 'all' || forceAll) ? nets : changed;
		await this._route(routeSet, projectNodeToRef);
		return true;
	}

	/**
	 * Route the given nets with a single PcbVisualizer pass and store results.
	 * @param nets nets to route
	 * @param projectNodeToRef projection into reference space
	 */
	async _route(nets, projectNodeToRef) {
		// Project pads into the reference coordinate space.
		const prepared = nets.map(net => {
			const pads = [];
			(net.nodes || []).forEach(node => {
				const p = projectNodeToRef(node);
				if (p && isFinite(p.x) && isFinite(p.y)) pads.push({ x: p.x, y: p.y });
			});
			return { net, pads };
		});

		// Nets with < 2 pads cannot be routed — store empty geometry but record
		// the current signature so they are not retried every refresh. Pad
		// positions are kept regardless, so a lone pin can still be rendered.
		prepared.forEach(({ net, pads }) => {
			if (pads.length < 2) {
				this.entries.set(net.id, {
					sig: NetSignature.of(net), name: net.name, wires: [], junctions: [], pads,
				});
			}
		});

		const routable = prepared.filter(p => p.pads.length >= 2);
		this.stats.routeCalls++;
		if (routable.length === 0) return;

		const M = await this._getModule();
		const pcb = new M.PcbVisualizer();
		try {
			routable.forEach(({ net, pads }) => {
				const vec = new M.VectorPoint2D();
				pads.forEach(p => vec.push_back({ x: p.x, y: p.y }));
				// Use the net id as routing key to avoid duplicate-name collisions.
				pcb.addNet({ name: net.id, pads: vec });
				vec.delete();
			});

			const result = pcb.route();
			const byKey = {};

			for (let i = 0; i < result.wires.size(); i++) {
				const wire = result.wires.get(i);
				const key = wire.net;
				if (!byKey[key]) byKey[key] = { wires: [], junctions: [] };
				const pts = [];
				for (let j = 0; j < wire.points.size(); j++) {
					const p = wire.points.get(j);
					pts.push({ x: p.x, y: p.y });
				}
				if (pts.length >= 2) byKey[key].wires.push(pts);
			}

			for (let i = 0; i < result.junctions.size(); i++) {
				const d = result.junctions.get(i);
				const key = d.net;
				if (!byKey[key]) byKey[key] = { wires: [], junctions: [] };
				byKey[key].junctions.push({ x: d.position.x, y: d.position.y });
			}

			routable.forEach(({ net, pads }) => {
				const data = byKey[net.id] || { wires: [], junctions: [] };
				this.entries.set(net.id, {
					sig: NetSignature.of(net), name: net.name,
					wires: data.wires, junctions: data.junctions, pads,
				});
			});
			this.stats.netsRouted += routable.length;
		} finally {
			try { if (pcb.clear) pcb.clear(); } catch (_) { /* ignore */ }
			try { if (pcb.delete) pcb.delete(); } catch (_) { /* ignore */ }
		}
	}
}

/**
 * Projects cached reference-space traces onto an individual PCB photo and
 * paints them. The projection function is supplied by the caller so the
 * existing perspective-transform logic is reused unchanged.
 */
class TraceRenderer {
	/**
	 * @param cache TraceCache instance
	 */
	constructor(cache) {
		this.cache = cache;
		this.tempCanvas = null; // Cached offscreen canvas to prevent frame-rate drops
	}

	/**
	 * Build the per-image draw list by projecting reference-space geometry.
	 *
	 * @param nets ordered net records (each with id)
	 * @param activeNetId id of the active net (labels + active colour)
	 * @param showInactive whether inactive net traces are visible
	 * @param projectPointFn (pt {x,y}) => {x,y}|null — ref space → image space
	 * @returns array of { netId, isActive, color, polylines:[[{x,y}]], junctions:[{x,y}], pads:[{x,y}] }
	 */
	buildDrawList(nets, activeNetId, showInactive, projectPointFn) {
		const list = [];
		for (const net of nets) {
			const isActive = net.id === activeNetId;
			if (!isActive && !showInactive) continue;

			const entry = this.cache.get(net.id);
			if (!entry) continue;

			const color = isActive ? TraceConfig.ACTIVE_TRACE_COLOR : TraceConfig.INACTIVE_TRACE_COLOR;

			const polylines = entry.wires.map(wire => {
				const out = [];
				for (const p of wire) {
					const q = projectPointFn(p);
					if (q) out.push(q);
				}
				return out;
			}).filter(pl => pl.length >= 2);

			const junctions = [];
			for (const j of entry.junctions) {
				const q = projectPointFn(j);
				if (q) junctions.push(q);
			}

			const pads = [];
			for (const p of (entry.pads || [])) {
				const q = projectPointFn(p);
				if (q) pads.push(q);
			}

			list.push({ netId: net.id, isActive, color, polylines, junctions, pads });
		}

		// Active net is drawn last so it sits on top of inactive traces.
		list.sort((a, b) => (a.isActive ? 1 : 0) - (b.isActive ? 1 : 0));
		return list;
	}

	/**
	 * Paint a prebuilt draw list onto a canvas context already transformed by
	 * the viewer (image space). Mirroring is applied per-point to match the
	 * node-label rendering in inspector.js.
	 *
	 * Rendering order per net mimics real copper: traces first, a small
	 * fillet at each junction to blend separate wire segments together, then
	 * pin pads (ring with a drilled hole) on top so connected pins read as
	 * through-hole pads rather than bare wire ends.
	 *
	 * @param ctx 2D canvas context (translated/scaled by the viewer)
	 * @param drawList output of buildDrawList()
	 * @param k current viewer scale
	 * @param mirrorWidth bitmap width when the view is mirrored, otherwise 0
	 */
	draw(ctx, drawList, k, mirrorWidth) {
		if (!drawList || !drawList.length) return;
		const ik = 1 / k;
		const mx = x => (mirrorWidth ? mirrorWidth - x : x);

		// Helper to calculate the shortest distance from point p to segment ab
		const distanceToSegment = (p, a, b) => {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const l2 = dx * dx + dy * dy;
			if (l2 === 0) {
				return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
			}
			let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
			t = Math.max(0, Math.min(1, t));
			const projX = a.x + t * dx;
			const projY = a.y + t * dy;
			return {
				dist: Math.hypot(p.x - projX, p.y - projY),
				t: t
			};
		};

		// Helper to walk along trace segments and determine the exact physical room for the fillet.
		// Stops instantly if we hit a pad or a sharp turn (>= 45 degrees).
		const getSmartPointAlongPolyline = (pl, startIndex, direction, targetDist, padCoords) => {
			let accumulatedDist = 0;
			let currIdx = startIndex;
			let prevDir = null;
			let remainingDist = targetDist;
			let currentPt = pl[startIndex];

			while (true) {
				const nextIdx = currIdx + direction;
				if (nextIdx < 0 || nextIdx >= pl.length || remainingDist <= 0) {
					return { pt: currentPt, actualDist: accumulatedDist };
				}

				const p1 = pl[currIdx];
				const p2 = pl[nextIdx];
				const dx = p2.x - p1.x;
				const dy = p2.y - p1.y;
				const len = Math.hypot(dx, dy);

				if (len === 0) {
					currIdx = nextIdx;
					continue;
				}

				const unitDir = { x: dx / len, y: dy / len };

				if (prevDir !== null) {
					const dot = prevDir.x * unitDir.x + prevDir.y * unitDir.y;
					// Sharp turn of 45 degrees or more (dot < 0.707): stop immediately at the vertex
					if (dot < 0.707) {
						return { pt: p1, actualDist: accumulatedDist };
					}
				}

				// Check if the next vertex p2 is close to a pad
				const nearPad = padCoords.some(pad => Math.hypot(p2.x - pad.x, p2.y - pad.y) < 2.0);

				if (len >= remainingDist) {
					const targetPt = {
						x: p1.x + unitDir.x * remainingDist,
						y: p1.y + unitDir.y * remainingDist
					};
					return { pt: targetPt, actualDist: accumulatedDist + remainingDist };
				}

				accumulatedDist += len;
				remainingDist -= len;
				prevDir = unitDir;
				currentPt = p2;

				if (nearPad) {
					return { pt: p2, actualDist: accumulatedDist };
				}

				currIdx = nextIdx;
			}
		};

		// Allocate or resize the offscreen canvas to match the main viewport
		if (!this.tempCanvas) {
			this.tempCanvas = document.createElement('canvas');
		}
		if (this.tempCanvas.width !== ctx.canvas.width || this.tempCanvas.height !== ctx.canvas.height) {
			this.tempCanvas.width = ctx.canvas.width;
			this.tempCanvas.height = ctx.canvas.height;
		}

		const tempCtx = this.tempCanvas.getContext('2d');
		tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
		tempCtx.globalCompositeOperation = 'source-over';

		// Copy transform from main canvas to draw in the correct space
		tempCtx.save();
		tempCtx.setTransform(ctx.getTransform());

		for (const item of drawList) {
			tempCtx.strokeStyle = item.color;
			tempCtx.fillStyle = item.color;
			tempCtx.lineWidth = TraceConfig.TRACE_WIDTH * ik;
			tempCtx.lineJoin = 'round';
			tempCtx.lineCap = 'round';

			// 1. Draw Wires
			for (const pl of item.polylines) {
				if (pl.length < 2) continue;

				tempCtx.beginPath();
				pl.forEach((p, i) => {
					const x = mx(p.x);
					if (i === 0) tempCtx.moveTo(x, p.y);
					else tempCtx.lineTo(x, p.y);
				});
				tempCtx.stroke();
			}

			// 2. Draw Junctions (filleted smooth corners)
			const rJunc = TraceConfig.JUNCTION_RADIUS * ik;

			for (const j of item.junctions) {
				const branches = [];

				for (const pl of item.polylines) {
					if (pl.length < 2) continue;

					// Find the single closest vertex of this polyline to the junction
					let minVertDist = Infinity;
					let closestVertIdx = -1;
					for (let i = 0; i < pl.length; i++) {
						const dist = Math.hypot(pl[i].x - j.x, pl[i].y - j.y);
						if (dist < minVertDist) {
							minVertDist = dist;
							closestVertIdx = i;
						}
					}

					// Find the single closest segment of this polyline to the junction
					let minSegDist = Infinity;
					let closestSegIdx = -1;
					for (let i = 0; i < pl.length - 1; i++) {
						const res = distanceToSegment(j, pl[i], pl[i + 1]);
						if (res.dist < minSegDist) {
							minSegDist = res.dist;
							closestSegIdx = i;
						}
					}

					// Target fillet size (fully matches JUNCTION_RADIUS)
					const targetWalkDist = rJunc;

					if (minVertDist < 1.5) {
						const idx = closestVertIdx;
						if (idx > 0) {
							const res = getSmartPointAlongPolyline(pl, idx, -1, targetWalkDist, item.pads);
							const dx = res.pt.x - j.x;
							const dy = res.pt.y - j.y;
							const len = Math.hypot(dx, dy);
							if (len > 0) {
								branches.push({
									dir: { x: dx / len, y: dy / len },
									maxLen: len
								});
							}
						}
						if (idx < pl.length - 1) {
							const res = getSmartPointAlongPolyline(pl, idx, 1, targetWalkDist, item.pads);
							const dx = res.pt.x - j.x;
							const dy = res.pt.y - j.y;
							const len = Math.hypot(dx, dy);
							if (len > 0) {
								branches.push({
									dir: { x: dx / len, y: dy / len },
									maxLen: len
								});
							}
						}
					} else if (minSegDist < 2.0) {
						const a = pl[closestSegIdx];
						const b = pl[closestSegIdx + 1];

						// Branch towards a (backward)
						const lenA = Math.hypot(a.x - j.x, a.y - j.y);
						if (lenA > 0) {
							const targetA = Math.max(0, targetWalkDist - lenA);
							const resA = getSmartPointAlongPolyline(pl, closestSegIdx, -1, targetA, item.pads);
							const dx = resA.pt.x - j.x;
							const dy = resA.pt.y - j.y;
							const len = Math.hypot(dx, dy);
							if (len > 0) {
								branches.push({
									dir: { x: dx / len, y: dy / len },
									maxLen: len
								});
							}
						}

						// Branch towards b (forward)
						const lenB = Math.hypot(b.x - j.x, b.y - j.y);
						if (lenB > 0) {
							const targetB = Math.max(0, targetWalkDist - lenB);
							const resB = getSmartPointAlongPolyline(pl, closestSegIdx + 1, 1, targetB, item.pads);
							const dx = resB.pt.x - j.x;
							const dy = resB.pt.y - j.y;
							const len = Math.hypot(dx, dy);
							if (len > 0) {
								branches.push({
									dir: { x: dx / len, y: dy / len },
									maxLen: len
								});
							}
						}
					}
				}

				// Deduplicate branch directions pointing the same way (within ~5.7 degrees)
				const uniqueBranches = [];
				for (const b of branches) {
					const angle = Math.atan2(b.dir.y, b.dir.x);
					let duplicate = false;
					for (const ub of uniqueBranches) {
						let diff = Math.abs(angle - ub.angle);
						if (diff > Math.PI) diff = 2 * Math.PI - diff;
						if (diff < 0.1) {
							duplicate = true;
							ub.maxLen = Math.min(ub.maxLen, b.maxLen);
							break;
						}
					}
					if (!duplicate) {
						uniqueBranches.push({
							dir: b.dir,
							angle: angle,
							maxLen: b.maxLen
						});
					}
				}

				if (uniqueBranches.length >= 2) {
					uniqueBranches.sort((a, b) => a.angle - b.angle);

					for (let i = 0; i < uniqueBranches.length; i++) {
						const b1 = uniqueBranches[i];
						const b2 = uniqueBranches[(i + 1) % uniqueBranches.length];

						// Avoid drawing flat fillets on straight runs (180 degrees)
						const dot = b1.dir.x * b2.dir.x + b1.dir.y * b2.dir.y;
						if (dot < -0.99) continue;

						// Use the physical distances calculated by the path walker directly
						const r1 = b1.maxLen;
						const r2 = b2.maxLen;

						const p1 = { x: j.x + b1.dir.x * r1, y: j.y + b1.dir.y * r1 };
						const p2 = { x: j.x + b2.dir.x * r2, y: j.y + b2.dir.y * r2 };

						tempCtx.beginPath();
						tempCtx.moveTo(mx(j.x), j.y);
						tempCtx.lineTo(mx(p1.x), p1.y);
						tempCtx.quadraticCurveTo(mx(j.x), j.y, mx(p2.x), p2.y);
						tempCtx.closePath();
						tempCtx.fill();
					}
				} else {
					// Fallback to solid circular dot if we cannot resolve multiple branch directions
					tempCtx.beginPath();
					tempCtx.arc(mx(j.x), j.y, rJunc, 0, Math.PI * 2);
					tempCtx.fill();
				}
			}

			// 3. Draw Solid Pads
			for (const p of item.pads) {
				const cx = mx(p.x), cy = p.y;
				tempCtx.beginPath();
				tempCtx.arc(cx, cy, TraceConfig.PAD_OUTER_RADIUS * ik, 0, Math.PI * 2);
				tempCtx.fill();
			}
		}

		// 4. Cleanly "drill" the holes through copper layer using transparent compositing
		tempCtx.globalCompositeOperation = 'destination-out';
		for (const item of drawList) {
			for (const p of item.pads) {
				const cx = mx(p.x), cy = p.y;
				tempCtx.beginPath();
				tempCtx.arc(cx, cy, TraceConfig.PAD_HOLE_RADIUS * ik, 0, Math.PI * 2);
				tempCtx.fill();
			}
		}

		tempCtx.restore();

		// Overlay the final rendered offscreen layers onto the main canvas
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform for direct 1:1 pixel copy
		ctx.drawImage(this.tempCanvas, 0, 0);
		ctx.restore();
	}
}

// Expose for CommonJS test environments without affecting browser globals.
if (typeof module !== 'undefined' && module.exports) {
	module.exports = { TraceConfig, NetSignature, TraceCache, TraceRenderer };
}
