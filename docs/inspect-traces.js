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
	/** Junction dot radius (screen pixels, scale-compensated). */
	JUNCTION_RADIUS: 4,
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
		/** netId → { sig, name, wires:[[{x,y}]], junctions:[{x,y}] } (reference space). */
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
		// the current signature so they are not retried every refresh.
		prepared.forEach(({ net, pads }) => {
			if (pads.length < 2) {
				this.entries.set(net.id, {
					sig: NetSignature.of(net), name: net.name, wires: [], junctions: [],
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

			routable.forEach(({ net }) => {
				const data = byKey[net.id] || { wires: [], junctions: [] };
				this.entries.set(net.id, {
					sig: NetSignature.of(net), name: net.name,
					wires: data.wires, junctions: data.junctions,
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
	}

	/**
	 * Build the per-image draw list by projecting reference-space geometry.
	 *
	 * @param nets ordered net records (each with id)
	 * @param activeNetId id of the active net (labels + active colour)
	 * @param showInactive whether inactive net traces are visible
	 * @param projectPointFn (pt {x,y}) => {x,y}|null — ref space → image space
	 * @returns array of { netId, isActive, color, polylines:[[{x,y}]], junctions:[{x,y}] }
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

			list.push({ netId: net.id, isActive, color, polylines, junctions });
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
	 * @param ctx 2D canvas context (translated/scaled by the viewer)
	 * @param drawList output of buildDrawList()
	 * @param k current viewer scale
	 * @param mirrorWidth bitmap width when the view is mirrored, otherwise 0
	 */
	draw(ctx, drawList, k, mirrorWidth) {
		if (!drawList || !drawList.length) return;
		const ik = 1 / k;
		const mx = x => (mirrorWidth ? mirrorWidth - x : x);

		for (const item of drawList) {
			ctx.strokeStyle = item.color;
			ctx.lineWidth = TraceConfig.TRACE_WIDTH * ik;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';

			for (const pl of item.polylines) {
				ctx.beginPath();
				pl.forEach((p, i) => {
					const x = mx(p.x);
					if (i === 0) ctx.moveTo(x, p.y);
					else ctx.lineTo(x, p.y);
				});
				ctx.stroke();
			}

			ctx.fillStyle = item.color;
			for (const j of item.junctions) {
				ctx.beginPath();
				ctx.arc(mx(j.x), j.y, TraceConfig.JUNCTION_RADIUS * ik, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}
}

// Expose for CommonJS test environments without affecting browser globals.
if (typeof module !== 'undefined' && module.exports) {
	module.exports = { TraceConfig, NetSignature, TraceCache, TraceRenderer };
}
