/* inspector.js - Visual Trace Tracking (v6) */

class Inspector {
	constructor(db, cv) {
		this.db = db;
		this.cv = cv;
		this.grid = document.getElementById('inspect-grid');
		this.sidebarList = document.getElementById('inspect-layers');
		this.activeNetEl = document.getElementById('inspect-active-net');

		this.viewers = {};
		this.visibleIds = new Set();
		this.activeNet = null;
		this.masterId = null;
		this.netNodeCache = {}; // Cache for calculated node positions
		this.bomCache = {}; // Cache for projected BOM coordinates

		// Cache for image dimensions to avoid async bitmap creation on every render
		this.resolutionCache = {};

		// Initialization State Lock
		this.initPromise = null;
		this.needsSync = false;
	}

	async getImageResolution(img) {
		if (!img || !img.blob) return { w: 0, h: 0 };
		if (this.resolutionCache[img.id]) return this.resolutionCache[img.id];
		try {
			const bmp = await createImageBitmap(img.blob);
			const res = { w: bmp.width, h: bmp.height };
			bmp.close();
			this.resolutionCache[img.id] = res;
			return res;
		} catch (e) { return { w: 0, h: 0 }; }
	}

	// Wrapper to prevent race conditions when switchView calls init()
	// and loadNet() is called immediately after
	async init() {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this._performInit();
		try {
			await this.initPromise;
		} finally {
			this.initPromise = null;
		}
	}

	async _performInit() {
		this.bomCache = {}; // Clear cache on re-init
		this.backImagesCache = null; // Clear back-side cache
		this.sidebarList.innerHTML = '';

		const newNetBtn = document.querySelector('button[onclick="inspector.startNewNet()"]');
		if(newNetBtn) newNetBtn.style.display = 'none';

		const sortedImgs = [...bomImages].sort((a,b) => {
			const nA = a.name.toLowerCase(), nB = b.name.toLowerCase();
			if(nA.includes('top')) return -1;
			if(nB.includes('top')) return 1;
			return nA.localeCompare(nB);
		});

		sortedImgs.forEach(img => {
			const row = document.createElement('div');
			row.style.cssText = "display:grid; grid-template-columns: 20px 1fr; align-items:center; gap:5px; color:#334155; font-size:0.85rem; border-bottom:1px solid #f1f5f9; padding-bottom:4px;";

			const chk = document.createElement('input');
			chk.type = 'checkbox';
			chk.dataset.id = img.id;
			chk.onchange = () => this.toggleLayer(img.id, chk.checked);

			const label = document.createElement('span');
			label.innerText = img.name;
			label.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
			label.title = img.name;

			row.appendChild(chk);
			row.appendChild(label);
			this.sidebarList.appendChild(row);
		});

		if(this.visibleIds.size === 0) {
			const isDesktop = window.matchMedia("(min-width: 800px)").matches;
			const nextVisible = new Set();

			if (isDesktop) {
				sortedImgs.forEach(img => nextVisible.add(img.id));
			} else {
				await this.selectBestMobilePair(sortedImgs, nextVisible);
			}

			this.visibleIds = nextVisible;
			Array.from(this.sidebarList.querySelectorAll('input')).forEach(chk => {
				chk.checked = this.visibleIds.has(chk.dataset.id);
			});
		} else {
			Array.from(this.sidebarList.querySelectorAll('input')).forEach(chk => {
				chk.checked = this.visibleIds.has(chk.dataset.id);
			});
		}

		this.updateNetUI();
		await this.renderGrid();
	}

	async selectBestMobilePair(sortedImgs, selectionSet) {
		let topCand = [], botCand = [], otherCand = [];

		for (const img of sortedImgs) {
			const n = img.name.toLowerCase();
			if (n.includes('top') || n.includes('front')) topCand.push(img);
			else if (n.includes('bot') || n.includes('back')) botCand.push(img);
			else otherCand.push(img);
		}

		let bestPair = null;
		let maxCombinedRes = 0;

		if (topCand.length > 0 && botCand.length > 0) {
			for (const t of topCand) {
				const paths = await ImageGraph.solvePaths(t.id, this.cv, this.db);
				const reachableIds = new Set(paths.map(p => p.id));
				const resT = await this.getImageResolution(t);
				const pxT = resT.w * resT.h;

				for (const b of botCand) {
					if (reachableIds.has(b.id)) {
						const resB = await this.getImageResolution(b);
						const totalPx = pxT + (resB.w * resB.h);
						if (totalPx > maxCombinedRes) {
							maxCombinedRes = totalPx;
							bestPair = [t, b];
						}
					}
				}
			}
		}

		if (!bestPair) {
			const pickBest = async (list) => {
				if (list.length === 0) return null;
				let best = list[0];
				let maxP = 0;
				for (const i of list) {
					const r = await this.getImageResolution(i);
					if ((r.w * r.h) > maxP) { maxP = r.w * r.h; best = i; }
				}
				return best;
			};
			const t = await pickBest(topCand);
			const b = await pickBest(botCand);
			if (t) selectionSet.add(t.id);
			if (b) selectionSet.add(b.id);
		} else {
			selectionSet.add(bestPair[0].id);
			selectionSet.add(bestPair[1].id);
		}

		if (selectionSet.size < 2) {
			const others = [...topCand, ...botCand, ...otherCand].filter(x => !selectionSet.has(x.id));
			for (const o of others) {
				if (selectionSet.size >= 2) break;
				selectionSet.add(o.id);
			}
		}
	}

	async renderGrid() {
		const savedStates = {};
		if (this.viewers) {
			Object.entries(this.viewers).forEach(([id, v]) => {
				if (v.t) savedStates[id] = { t: { ...v.t }, interacted: v.userInteracted || false };
			});
		}

		this.grid.innerHTML = '';
		this.viewers = {};

		if(this.visibleIds.size === 0) {
			this.grid.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; color:#64748b; height:100%;">Select layers to inspect</div>';
			return;
		}

		// --- SMART GRID CALCULATION (Aspect Ratio Aware) ---
		const count = this.visibleIds.size;
		const rect = this.grid.getBoundingClientRect();
		const width = rect.width || window.innerWidth;
		const height = rect.height || window.innerHeight;

		// 1. Calculate Average Aspect Ratio
		let totalAR = 0;
		let validARCount = 0;
		for (const id of this.visibleIds) {
			const imgRec = bomImages.find(i => i.id === id);
			if (imgRec) {
				const res = await this.getImageResolution(imgRec);
				if (res.w > 0 && res.h > 0) {
					totalAR += (res.w / res.h);
					validARCount++;
				}
			}
		}
		const avgAR = (validARCount > 0) ? (totalAR / validARCount) : 1.5;

		// 2. Solve for Best Layout (Maximize Scale)
		let bestCols = 1;
		let maxScale = 0;

		for (let c = 1; c <= count; c++) {
			const r = Math.ceil(count / c);
			const cellW = width / c;
			const cellH = height / r;
			const scale = Math.min(cellW / avgAR, cellH);

			if (scale > maxScale) {
				maxScale = scale;
				bestCols = c;
			}
		}

		const cols = bestCols;
		const rows = Math.ceil(count / cols);

		this.grid.style.display = 'grid';
		this.grid.style.width = '100%';
		this.grid.style.height = '100%';
		this.grid.style.boxSizing = 'border-box';
		this.grid.style.gap = '2px';
		this.grid.style.background = '#000';
		this.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
		this.grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

		if(!this.masterId || !this.visibleIds.has(this.masterId)) {
			this.masterId = this.visibleIds.values().next().value;
		}

		for(const id of this.visibleIds) {
			const imgRec = bomImages.find(i => i.id === id);
			if(!imgRec) continue;

			const cell = document.createElement('div');
			cell.style.cssText = "position:relative; overflow:hidden; border:1px solid #334155; background:#000; width:100%; height:100%; min-width:0; min-height:0;";

			const cvs = document.createElement('canvas');
			cvs.id = `inspect-cvs-${id}`;
			cvs.style.cssText = "display:block; position:absolute; top:0; left:0; width:100%; height:100%;";
			cell.appendChild(cvs);

			const lbl = document.createElement('div');
			lbl.innerText = imgRec.name;
			lbl.style.cssText = "position:absolute; top:5px; left:5px; background:rgba(0,0,0,0.7); padding:2px 6px; font-size:0.7rem; pointer-events:none; border-radius:3px; color:white;";
			cell.appendChild(lbl);

			this.grid.appendChild(cell);

			let wasActiveBeforeDown = false;
			let stateRestored = false;

			const viewer = new PanZoomCanvas(cvs.id,
				(ctx, k) => this.drawOverlay(id, ctx, k),
				async (x, y, e) => {
					if (e.button !== 0) return;
					if (wasActiveBeforeDown) {
						const hit = await this.handleNodeClick(id, x, y);
						if (!hit) {
							await this.handleAddNode(id, x, y);
						}
					}
				},
				// Drag Handler
				(dx, dy, mode, idx) => {
					if (!this.activeNet) return -1;
					if (mode === 'check') {
						const cache = this.netNodeCache[id];
						if (!cache) return -1;
						// Only allow dragging Source (Blue) nodes
						const foundIdx = cache.findIndex(n => {
							if (!n.isSource) return false;
							const dist = Math.hypot(n.x - dx, n.y - dy);
							return (dist * viewer.t.k) < 20;
						});
						return foundIdx;
					} else if (mode === 'move') {
						const n = this.netNodeCache[id][idx];
						if (n && n.origNode) {
							// Update Data Model
							n.origNode.x += dx;
							n.origNode.y += dy;
							// Update Visual Cache
							n.x += dx;
							n.y += dy;
							viewer.draw();
							this.needsSync = true;
						}
					}
				}
			);

			viewer.userInteracted = false;

			viewer.onPointerDown = (e) => {
				viewer.userInteracted = true;
				if (e.isPrimary || e.button === 0) {
					wasActiveBeforeDown = (this.masterId === id);
					if (this.masterId !== id) {
						this.masterId = id;
						this.syncCursors(id, null, null, true);
					}
					const pt = viewer.getImgCoords(e.clientX, e.clientY);
					this.syncCursors(id, pt.x, pt.y);
				}
			};

			// Trigger re-projection when drag ends
			cvs.addEventListener('pointerup', () => {
				if(this.needsSync) {
					this.updateNetNodeCache();
					this.needsSync = false;
				}
			});

			cvs.addEventListener('wheel', () => { viewer.userInteracted = true; });

			viewer.onMouseMove = (x, y) => {
				if(this.masterId === id) this.syncCursors(id, x, y);
			};

			const updateView = () => {
				if (!viewer.bmp || cvs.width < 20 || cvs.height < 20) return;
				if (savedStates[id] && savedStates[id].interacted && !stateRestored) {
					viewer.t = savedStates[id].t;
					stateRestored = true;
					viewer.userInteracted = true;
					viewer.draw();
				}
				else if (!viewer.userInteracted) {
					viewer.fit();
				}
			};

			viewer.onResize = (w, h) => updateView();

			cvs.addEventListener('contextmenu', (e) => {
				e.preventDefault(); e.stopPropagation();
				this.masterId = null;
				this.cursorState = null;
				Object.values(this.viewers).forEach(v => {
					v.cursorPos = null; v.setDimmed(false); v.draw();
				});
			});

			this.viewers[id] = viewer;

			try {
				const bmp = await createImageBitmap(imgRec.blob);
				viewer.setImage(bmp);
				updateView();

				if(imgRec.name.toLowerCase().includes('bot') && !imgRec.name.toLowerCase().includes('top')) {
					viewer.setMirror(true);
				}
			} catch(e) { console.error("Inspector img load error", e); }
		}
		this.updateNetNodeCache();
		if (this.masterId) this.syncCursors(this.masterId, null, null, true);
	}

	async handleNodeClick(imgId, x, y) {
		if (!this.activeNet || !this.netNodeCache[imgId]) return false;
		const viewer = this.viewers[imgId];
		if (!viewer) return false;

		const HIT_RADIUS = 20;
		const hit = this.netNodeCache[imgId].find(n => {
			const dist = Math.hypot(n.x - x, n.y - y);
			return (dist * viewer.t.k) < HIT_RADIUS;
		});

		if (hit) {
			const res = await requestInput("Edit Node", "Node Name", hit.label, {
				extraBtn: { label: 'Delete', value: '__DELETE__', class: 'danger' },
				helpHtml: PIN_HELP_HTML
			});
			if (res === '__DELETE__') {
				const idx = this.activeNet.nodes.indexOf(hit.origNode);
				if (idx > -1) this.activeNet.nodes.splice(idx, 1);
			} else if (res) {
				hit.origNode.label = res;
			}
			if (res) {
				this.updateNetUI();
				Object.values(this.viewers).forEach(v => v.draw());
			}
			return true;
		}
		return false;
	}

	toggleLayer(id, isVisible) {
		if(isVisible) this.visibleIds.add(id);
		else this.visibleIds.delete(id);
		this.renderGrid();
	}

	async loadNet(net) {
		// Wait for initialization to complete if triggered by switchView()
		if (this.initPromise) {
			await this.initPromise;
		}

		this.activeNet = JSON.parse(JSON.stringify(net));
		this.updateNetUI();

		if(Object.keys(this.viewers).length === 0) {
			await this.renderGrid();
		} else {
			Object.values(this.viewers).forEach(v => v.draw());
		}
	}

	async updateNetNodeCache() {
		this.netNodeCache = {};
		if (!this.activeNet || !this.activeNet.nodes) return;

		// Initialize arrays for currently visible layers
		for (const vid of this.visibleIds) this.netNodeCache[vid] = [];

		for (const node of this.activeNet.nodes) {
			// 1. Direct Nodes (Source)
			// Safety Check: Ensure the cache array exists before pushing
			if (this.netNodeCache[node.imgId]) {
				this.netNodeCache[node.imgId].push({
					x: node.x, y: node.y, label: node.label,
					color: '#2563eb', isSource: true, origNode: node
				});
			}

			// 2. Inferred Nodes (Projected)
			const paths = await ImageGraph.solvePaths(node.imgId, this.cv, this.db);
			for (const p of paths) {
				// CHANGE: Check this.netNodeCache[p.id] instead of this.visibleIds.has(p.id)
				// This prevents the crash if netNodeCache was reset by a concurrent call
				if (this.netNodeCache[p.id]) {
					const proj = this.cv.projectPoint(node.x, node.y, p.H);
					if (proj) {
						this.netNodeCache[p.id].push({
							x: proj.x, y: proj.y, label: node.label,
							color: '#4ade80', isSource: false, origNode: node
						});
					}
				}
			}
		}
		Object.values(this.viewers).forEach(v => v.draw());
	}

	async syncCursors(masterId, mx, my, forceRefresh = false) {
		if (mx !== null && my !== null) {
			this.cursorState = { masterId, mx, my };
		} else if (!forceRefresh && !this.cursorState) {
			return;
		}

		const path = await ImageGraph.solvePaths(masterId, this.cv, this.db);
		const connectedIds = new Set(path.map(p => p.id));
		connectedIds.add(masterId);

		for(const [id, viewer] of Object.entries(this.viewers)) {
			if(id === masterId) {
				viewer.setDimmed(false);
				viewer.draw();
				continue;
			}

			if(!connectedIds.has(id)) {
				viewer.cursorPos = null;
				viewer.setDimmed(true);
				viewer.draw();
				continue;
			}

			const targetPath = path.find(p => p.id === id);

			if (mx !== null && my !== null && targetPath) {
				const pt = this.cv.projectPoint(mx, my, targetPath.H);
				if(pt) {
					viewer.cursorPos = pt;
					const w = viewer.bmp ? viewer.bmp.width : 1000;
					const h = viewer.bmp ? viewer.bmp.height : 1000;

					const inside = (pt.x >= 0 && pt.y >= 0 && pt.x <= w && pt.y <= h);
					viewer.setDimmed(!inside);

					if (inside && viewer.bmp) {
						const k = viewer.t.k;
						const tx = viewer.t.x;
						const ty = viewer.t.y;
						const imgX = viewer.isMirrored ? (w - pt.x) : pt.x;
						const screenX = imgX * k + tx;
						const screenY = pt.y * k + ty;
						const cvsW = viewer.canvas.width;
						const cvsH = viewer.canvas.height;
						const padX = cvsW * 0.25;
						const padY = cvsH * 0.25;

						let dx = 0, dy = 0;
						if (screenX > cvsW - padX) dx = (cvsW - padX) - screenX;
						else if (screenX < padX) dx = padX - screenX;
						if (screenY > cvsH - padY) dy = (cvsH - padY) - screenY;
						else if (screenY < padY) dy = padY - screenY;

						if (dx !== 0 || dy !== 0) {
							viewer.t.x += dx;
							viewer.t.y += dy;
						}
					}
				} else {
					viewer.cursorPos = null;
					viewer.setDimmed(true);
				}
			} else {
				viewer.setDimmed(false);
			}
			viewer.draw();
		}
	}

	drawOverlay(id, ctx, k) {
		const viewer = this.viewers[id];
		if (!viewer) return;
		const ik = 1/k;

		if (this.netNodeCache[id]) {
			this.netNodeCache[id].forEach(n => {
				let drawX = n.x;
				if (viewer.isMirrored && viewer.bmp) drawX = viewer.bmp.width - n.x;

				ctx.save();
				ctx.translate(drawX, n.y);
				ctx.scale(ik, ik);
				ctx.rotate(-Math.PI / 4);

				const s = 20, r = 10;
				ctx.beginPath();
				ctx.moveTo(0, 0);
				ctx.lineTo(0, -s + r); ctx.arcTo(0, -s, s, -s, r);
				ctx.lineTo(s - r, -s); ctx.arcTo(s, -s, s, 0, r);
				ctx.lineTo(s, -r); ctx.arcTo(s, 0, 0, 0, r);
				ctx.lineTo(0, 0);
				ctx.closePath();

				ctx.fillStyle = n.color;
				ctx.fill();
				ctx.lineWidth = 1.5;
				ctx.strokeStyle = 'white';
				ctx.stroke();

				ctx.translate(s/2, -s/2);
				ctx.rotate(Math.PI / 4);
				ctx.fillStyle = 'white';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.font = 'bold 9px sans-serif';
				ctx.fillText(n.label, 0, 0);
				ctx.restore();
			});
		}

		let cx, cy, color = '#ff0000';
		if(this.cursorState && this.cursorState.masterId === id) {
			cx = this.cursorState.mx; cy = this.cursorState.my;
			if(viewer.isMirrored && viewer.bmp) cx = viewer.bmp.width - cx;
		} else if (viewer.cursorPos) {
			cx = viewer.cursorPos.x; cy = viewer.cursorPos.y;
			if(viewer.isMirrored && viewer.bmp) cx = viewer.bmp.width - cx;
			color = '#facc15';
		}

		if(cx !== undefined) {
			const len = 100000;
			ctx.lineWidth = 1 * ik;
			ctx.strokeStyle = color;
			ctx.beginPath();
			ctx.moveTo(cx - len, cy); ctx.lineTo(cx + len, cy);
			ctx.moveTo(cx, cy - len); ctx.lineTo(cx, cy + len);
			ctx.stroke();
		}
	}

	// --- SMART NAMING LOGIC ---

	async calculateGlobalRotation() {
		// Default to 0 if data missing
		if (typeof currentBomId === 'undefined' || typeof bomData === 'undefined') return 0;

		const allNets = await this.db.getNets();
		const projectNets = allNets.filter(n => n.projectId === currentBomId);

		let totalAngle = 0;
		let count = 0;

		// We only trust 2-pin passive components for orientation
		// (Resistors, Caps, Inductors, Diodes).
		// ICs are complex, Transistors have triangles.
		const SAFE_PREFIXES = ['R', 'C', 'L', 'D', 'VD'];

		projectNets.forEach(net => {
			net.nodes.forEach(node => {
				// Find the component this node belongs to
				// Node label format "R1.1" -> Ref "R1"
				const parts = node.label.split('.');
				if (parts.length !== 2) return;

				const ref = parts[0];

				// Check prefix
				const prefix = ref.match(/^[A-Z]+/);
				if (!prefix || !SAFE_PREFIXES.includes(prefix[0])) return;

				const comp = bomData.find(c => c.label === ref);

				// Critical: We must use coordinates from the SAME image to calculate angle
				if (comp && comp.imgId === node.imgId && comp.x !== undefined) {
					const dx = node.x - comp.x;
					const dy = node.y - comp.y;

					// Calculate raw angle in degrees
					let deg = Math.atan2(dy, dx) * (180 / Math.PI);

					// Normalize to deviation from nearest 90-degree axis (-45 to +45)
					// Examples:
					// 5 deg -> 5
					// 85 deg -> -5 (relative to 90)
					// 175 deg -> -5 (relative to 180)
					while (deg <= -45) deg += 90;
					while (deg > 45) deg -= 90;

					// Filter outliers (e.g. diagonal placement)
					// User requested up to 15 degrees, we allow 20 for safety
					if (Math.abs(deg) < 20) {
						totalAngle += deg;
						count++;
					}
				}
			});
		});

		if (count === 0) return 0;

		// Return average rotation in Radians
		const avgDeg = totalAngle / count;
		return avgDeg * (Math.PI / 180);
	}

	async detectBackImages() {
		if (this.backImagesCache) return this.backImagesCache;
		if (typeof currentBomId === 'undefined' || typeof bomImages === 'undefined') return new Set();

		const overlaps = await this.db._tx('overlappedImages', 'readonly', s => s.getAll());

		// 1. Build Adjacency Graph (Partitioning)
		const polarity = {}; // 1 vs -1
		const adj = {};

		overlaps.forEach(ov => {
			if(!adj[ov.fromImageId]) adj[ov.fromImageId] = [];
			if(!adj[ov.toImageId]) adj[ov.toImageId] = [];

			// Determinant < 0 implies reflection (Flip)
			const h = ov.homography;
			const det = (h[0] * h[4]) - (h[1] * h[3]);
			const isFlip = det < 0;

			adj[ov.fromImageId].push({ target: ov.toImageId, isFlip });
			adj[ov.toImageId].push({ target: ov.fromImageId, isFlip });
		});

		// BFS to propagate polarity
		const visited = new Set();
		const queue = [];

		const startImg = bomImages[0];
		if (!startImg) return new Set();

		polarity[startImg.id] = 1;
		queue.push(startImg.id);
		visited.add(startImg.id);

		while(queue.length > 0) {
			const curr = queue.shift();
			const curPol = polarity[curr];

			if (adj[curr]) {
				adj[curr].forEach(edge => {
					if (!visited.has(edge.target)) {
						visited.add(edge.target);
						polarity[edge.target] = edge.isFlip ? -curPol : curPol;
						queue.push(edge.target);
					}
				});
			}
		}

		const groupA = new Set(Object.keys(polarity).filter(k => polarity[k] === 1));
		const groupB = new Set(Object.keys(polarity).filter(k => polarity[k] === -1));

		// 2. Heuristic 2: Check existing Resistor Nets (Reliable)
		// Now checks both Pin 1 and Pin 2
		const rot = await this.calculateGlobalRotation();
		const cosR = Math.cos(-rot);
		const sinR = Math.sin(-rot);

		let scoreA = 0; // Positive = A is Top, Negative = A is Back

		const allNets = await this.db.getNets();
		const projectNets = allNets.filter(n => n.projectId === currentBomId);

		for (const net of projectNets) {
			for (const node of net.nodes) {
				// Match R*.1 OR R*.2
				const match = node.label.match(/^(R\d+)\.([12])$/);
				if (!match) continue;

				const ref = match[1];
				const pinSuffix = match[2]; // '1' or '2'

				const comp = bomData.find(c => c.label === ref);

				// Ensure node and component are on the same image
				if (comp && comp.imgId === node.imgId && comp.x !== undefined) {
					const dx = node.x - comp.x;
					const dy = node.y - comp.y;

					// Rotate to align with horizontal axis
					const rDx = dx * cosR - dy * sinR;

					// Rule for TOP side:
					// Pin 1 is Left (<0).
					// Pin 2 is Right (>0).
					const isTopBehavior = (pinSuffix === '1') ? (rDx < 0) : (rDx > 0);

					if (groupA.has(node.imgId)) scoreA += (isTopBehavior ? 1 : -1);
					else if (groupB.has(node.imgId)) scoreA += (isTopBehavior ? -1 : 1);
				}
			}
		}

		if (scoreA !== 0) {
			this.backImagesCache = scoreA > 0 ? groupB : groupA;
			return this.backImagesCache;
		}

		// 3. Heuristic 1: Count (Fallback)
		if (groupB.size === 0) this.backImagesCache = new Set();
		else if (groupA.size === 0) this.backImagesCache = groupA;
		else this.backImagesCache = (groupA.size <= groupB.size) ? groupA : groupB;

		return this.backImagesCache;
	}

	async getProjectedComponents(targetImgId) {
		if (this.bomCache[targetImgId]) return this.bomCache[targetImgId];

		const projected = [];

		// 1. Calculate paths FROM the target TO everything else
		// We want to answer: "Where is Image X relative to ME (Target)?"
		// This runs Dijkstra once (One-to-Many) instead of Many-to-One
		let pathMap = {};

		if (typeof ImageGraph !== 'undefined') {
			// solvePaths returns H for: Target -> Remote
			const paths = await ImageGraph.solvePaths(targetImgId, this.cv, this.db);

			paths.forEach(p => {
				// To render a Remote component on Target, we need: Remote -> Target
				// So we invert the matrix: inv(Target -> Remote)
				const invH = ImageGraph.invertH(p.H);
				if (invH) pathMap[p.id] = invH;
			});
		}

		// 2. Iterate all components and project them
		if (typeof bomData !== 'undefined') {
			bomData.forEach(c => {
				if (!c.imgId) return;

				// Case A: Component is on the current image (Direct)
				if (c.imgId === targetImgId) {
					if (c.x !== undefined && c.y !== undefined) {
						projected.push({ ...c, projX: c.x, projY: c.y });
					}
				}
				// Case B: Component is on a connected image (Inferred)
				else if (pathMap[c.imgId]) {
					if (c.x !== undefined && c.y !== undefined) {
						const H = pathMap[c.imgId];
						const pt = this.cv.projectPoint(c.x, c.y, H);

						// Basic sanity bounds to prevent projecting into infinity
						// (can happen with near-singular matrices or extreme perspective)
						if (pt && Math.abs(pt.x) < 50000 && Math.abs(pt.y) < 50000) {
							projected.push({ ...c, projX: pt.x, projY: pt.y });
						}
					}
				}
			});
		}

		this.bomCache[targetImgId] = projected;
		return projected;
	}

	async checkGlobalLabelUsage(label) {
		// dependency: currentBomId is global from studio.js
		if (!label || typeof currentBomId === 'undefined') return false;

		// 1. Fetch ALL nets (Async)
		// Optimization: In a huge app we'd index this, but filtering memory is fast enough for <10k nets
		const allNets = await this.db.getNets();

		// 2. Filter for current board
		const projectNets = allNets.filter(n => n.projectId === currentBomId);

		// 3. Scan for label collision
		for (const net of projectNets) {
			if (net.nodes && net.nodes.some(n => n.label === label)) {
				return true;
			}
		}
		return false;
	}

	async getSuggestedLabel(imgId, x, y) {
		const HIT_RADIUS = 150;

		// 1. Get Data
		const components = await this.getProjectedComponents(imgId);
		const rotation = await this.calculateGlobalRotation();
		const backImages = await this.detectBackImages();
		const isBack = backImages.has(imgId);

		const cosR = Math.cos(-rotation);
		const sinR = Math.sin(-rotation);

		let bestComp = null;
		let minScore = Infinity;

		// 2. Weighted Scoring Loop
		components.forEach(c => {
			const dx = x - c.projX;
			const dy = y - c.projY;
			const dist = Math.hypot(dx, dy);

			if (dist < HIT_RADIUS) {
				// Rotate vector
				const rDx = dx * cosR - dy * sinR;
				const rDy = dx * sinR + dy * cosR;

				let angleDeg = Math.abs(Math.atan2(rDy, rDx) * (180 / Math.PI));
				angleDeg = angleDeg % 90;
				let deviation = Math.min(angleDeg, 90 - angleDeg);

				const score = dist * (1 + (deviation * 0.1));

				if (score < minScore) {
					minScore = score;
					bestComp = c;
				}
			}
		});

		if (!bestComp) return null;

		// 3. Pin Logic
		const bDx = x - bestComp.projX;
		const bDy = y - bestComp.projY;

		const rotDx = bDx * cosR - bDy * sinR;
		const rotDy = bDx * sinR + bDy * cosR;

		// Logic Branch:
		// Top Side: Left/Top is 1 => (rotDx + rotDy) < 0
		// Back Side: Right/Top is 1 => (rotDx - rotDy) > 0
		let isPin1;
		if (isBack) {
			// Back: Favor Right (x>0) and Top (y<0).
			// x - y => pos - neg = pos.
			isPin1 = (rotDx - rotDy) > 0;
		} else {
			// Top: Favor Left (x<0) and Top (y<0).
			// x + y => neg + neg = neg.
			isPin1 = (rotDx + rotDy) < 0;
		}

		const primaryPin = isPin1 ? '1' : '2';
		const secondaryPin = isPin1 ? '2' : '1';

		const labelPrimary = `${bestComp.label}.${primaryPin}`;
		const labelSecondary = `${bestComp.label}.${secondaryPin}`;

		const primaryTaken = await this.checkGlobalLabelUsage(labelPrimary);
		return primaryTaken ? labelSecondary : labelPrimary;
	}

	startNewNet() {
		this.activeNet = { id: uuid(), name: "New Net", nodes: [], isNew: true };
		this.updateNetUI();
	}

	async handleAddNode(imgId, x, y) {
		const nextIdx = this.activeNet ? this.activeNet.nodes.length + 1 : 1;
		let defaultLabel = `P${nextIdx}`;

		// NEW: Async Smart Suggestion
		const smartLabel = await this.getSuggestedLabel(imgId, x, y);
		if (smartLabel) defaultLabel = smartLabel;

		const label = await requestInput("Add Node", "Pad/Pin Name", defaultLabel, {
			helpHtml: (typeof PIN_HELP_HTML !== 'undefined') ? PIN_HELP_HTML : null
		});

		if(label) {
			if(!this.activeNet) this.startNewNet();
			this.activeNet.nodes.push({ id: uuid(), imgId: imgId, x: Math.round(x), y: Math.round(y), label: label });
			this.updateNetUI();
			Object.values(this.viewers).forEach(v => v.draw());
		}
	}

	async saveNet() {
		if(!this.activeNet) return;
		if (this.activeNet.isNew) {
			const name = await requestInput("Save Net", "Net Name", this.activeNet.name);
			if(name) { this.activeNet.name = name; delete this.activeNet.isNew; }
			else return;
		}
		this.activeNet.projectId = currentBomId;
		await this.db.addNet(this.activeNet);
		this.activeNet = null;
		this.updateNetUI();
		if(window.netManager) window.netManager.render();
	}

	cancelNet() {
		this.activeNet = null;
		this.updateNetUI();
		history.back();
	}

	updateNetUI() {
		if(!this.activeNet) {
			this.activeNetEl.style.display = 'none';
		} else {
			this.activeNetEl.style.cssText = "pointer-events:auto; background:rgba(15, 23, 42, 0.9); padding:4px 10px; border-radius:20px; border:1px solid #334155; display:flex; color:white; align-items:center; gap:8px; box-shadow:0 4px 6px rgba(0,0,0,0.2); backdrop-filter:blur(4px); font-size:0.85rem; height:auto;";
			this.activeNetEl.innerHTML = `
				<span style="font-weight:600; color:#4ade80; max-width:100px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.activeNet.name}</span>
				<span style="color:#94a3b8; border-left:1px solid #475569; padding-left:8px; font-size:0.8rem;">${this.activeNet.nodes.length}</span>
				<button class="primary sm-btn" style="padding:1px 8px; font-size:0.75rem; height:24px; min-height:0; line-height:1;" onclick="inspector.saveNet()">Save</button>
				<button class="danger sm-btn" style="padding:0; width:20px; height:20px; min-height:0; border-radius:50%; line-height:1; display:flex; align-items:center; justify-content:center;" onclick="inspector.cancelNet()">×</button>
			`;
		}
		this.updateNetNodeCache();
	}
}
