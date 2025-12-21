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
	}

	async init() {
		this.sidebarList.innerHTML = '';

		// Hide the "+ New Net" button for now
		// We find it by the onclick attribute since it doesn't have an ID in the HTML
		const newNetBtn = document.querySelector('button[onclick="inspector.startNewNet()"]');
		if(newNetBtn) newNetBtn.style.display = 'none';

		const imgs = [...bomImages].sort((a,b) => {
			const nA = a.name.toLowerCase(), nB = b.name.toLowerCase();
			if(nA.includes('top')) return -1;
			if(nB.includes('top')) return 1;
			return nA.localeCompare(nB);
		});

		// Checkbox Layout
		imgs.forEach(img => {
			const row = document.createElement('div');
			// Force Grid layout for strict alignment of checkbox vs label
			row.style.cssText = "display:grid; grid-template-columns: 20px 1fr; align-items:center; gap:5px; color:#334155; font-size:0.85rem; border-bottom:1px solid #f1f5f9; padding-bottom:4px;";

			const chk = document.createElement('input');
			chk.type = 'checkbox';
			chk.checked = this.visibleIds.has(img.id);
			chk.onchange = () => this.toggleLayer(img.id, chk.checked);

			const label = document.createElement('span');
			label.innerText = img.name;
			label.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
			label.title = img.name;

			row.appendChild(chk);
			row.appendChild(label);
			this.sidebarList.appendChild(row);
		});

		// Smart Default Selection
		if(this.visibleIds.size === 0) {
			const isDesktop = window.matchMedia("(min-width: 800px)").matches;
			if (isDesktop) {
				imgs.forEach(img => this.visibleIds.add(img.id));
			} else {
				if (imgs.length > 0) this.visibleIds.add(imgs[0].id);
				if (imgs.length > 1) this.visibleIds.add(imgs[1].id);
			}
			// Sync UI
			Array.from(this.sidebarList.querySelectorAll('input')).forEach((chk, i) => {
				chk.checked = this.visibleIds.has(imgs[i].id);
			});
		}

		this.updateNetUI();
		this.renderGrid();
	}

	async renderGrid() {
		// 1. Snapshot State
		// We save state ONLY if the viewer exists.
		// We also capture 'interacted' status to know if we should restore specific zoom or just auto-fit.
		const savedStates = {};
		if (this.viewers) {
			Object.entries(this.viewers).forEach(([id, v]) => {
				if (v.t) {
					savedStates[id] = {
						t: { ...v.t },
						interacted: v.userInteracted || false // Capture the flag from the instance
					};
				}
			});
		}

		this.grid.innerHTML = '';
		this.viewers = {};

		if(this.visibleIds.size === 0) {
			this.grid.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; color:#64748b; height:100%;">Select layers to inspect</div>';
			return;
		}

		// Grid Layout
		this.grid.style.display = 'grid';
		this.grid.style.width = '100%';
		this.grid.style.height = '100%';
		this.grid.style.boxSizing = 'border-box';
		this.grid.style.gap = '2px';
		this.grid.style.background = '#000';

		const count = this.visibleIds.size;
		const isPortrait = window.innerHeight > window.innerWidth;

		if (isPortrait) {
			this.grid.style.gridTemplateColumns = '1fr';
			this.grid.style.gridTemplateRows = `repeat(${count}, 1fr)`;
		} else {
			this.grid.style.gridTemplateColumns = (count > 1) ? '1fr 1fr' : '1fr';
			this.grid.style.gridTemplateRows = (count > 2) ? '1fr 1fr' : '1fr';
		}

		if(!this.masterId || !this.visibleIds.has(this.masterId)) {
			this.masterId = this.visibleIds.values().next().value;
		}

		for(const id of this.visibleIds) {
			const imgRec = bomImages.find(i => i.id === id);
			if(!imgRec) continue;

			const cell = document.createElement('div');
			cell.style.cssText = "position:relative; overflow:hidden; border:1px solid #334155; background:#000; width:100%; height:100%;";

			const cvs = document.createElement('canvas');
			cvs.id = `inspect-cvs-${id}`;
			cvs.style.display = 'block';
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
				(dx, dy, mode) => {
					if(mode === 'check') return -1;
				}
			);

			// Initialize interaction flag on the instance
			viewer.userInteracted = false;

			// --- EVENT HANDLERS ---

			viewer.onPointerDown = (e) => {
				viewer.userInteracted = true; // Mark as dirty/manual

				if (e.isPrimary || e.button === 0) {
					wasActiveBeforeDown = (this.masterId === id);
					if (this.masterId !== id) {
						this.masterId = id;
					}
					const pt = viewer.getImgCoords(e.clientX, e.clientY);
					this.syncCursors(id, pt.x, pt.y);
				}
			};

			// Detect wheel usage to stop auto-fit
			cvs.addEventListener('wheel', () => { viewer.userInteracted = true; });

			viewer.onMouseMove = (x, y) => {
				if(this.masterId === id) this.syncCursors(id, x, y);
			};

			// --- SMART RESIZE/FIT LOGIC ---
			const updateView = () => {
				if (!viewer.bmp || cvs.width < 20 || cvs.height < 20) return;

				// 1. Restore State (Only if user had manually interacted before)
				if (savedStates[id] && savedStates[id].interacted && !stateRestored) {
					viewer.t = savedStates[id].t;
					stateRestored = true;
					viewer.userInteracted = true; // Keep it marked as manual
					viewer.draw();
				}
				// 2. Auto-Fit (Default behavior, continues on resize until user interacts)
				else if (!viewer.userInteracted) {
					viewer.fit();
				}
			};

			// Attempt fit on Resize
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

				// Attempt fit on Load
				updateView();

				if(imgRec.name.toLowerCase().includes('bot') && !imgRec.name.toLowerCase().includes('top')) {
					viewer.setMirror(true);
				}
			} catch(e) { console.error("Inspector img load error", e); }
		}
		this.updateNetNodeCache();
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
			// Use generic input with a special Delete button
			const res = await requestInput("Edit Node", "Node Name", hit.label, {
				extraBtn: { label: 'Delete', value: '__DELETE__', class: 'danger' }
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

	// Load an existing net for editing
	loadNet(net) {
		// Deep copy to ensure "Cancel" works (discarding changes)
		this.activeNet = JSON.parse(JSON.stringify(net));
		this.updateNetUI();

		// Ensure pins are visible immediately
		// We might need to ensure grid is rendered if not already
		if(Object.keys(this.viewers).length === 0) {
			this.renderGrid().then(() => {
				Object.values(this.viewers).forEach(v => v.draw());
			});
		} else {
			Object.values(this.viewers).forEach(v => v.draw());
		}
	}

	async updateNetNodeCache() {
		this.netNodeCache = {};
		if (!this.activeNet || !this.activeNet.nodes) return;

		// Initialize cache arrays for visible viewers
		for (const vid of this.visibleIds) this.netNodeCache[vid] = [];

		// Process each node in the net
		for (const node of this.activeNet.nodes) {
			// 1. Add directly to the source image (Blue)
			if (this.visibleIds.has(node.imgId)) {
				this.netNodeCache[node.imgId].push({
					x: node.x, y: node.y, label: node.label,
					color: '#2563eb', isSource: true, origNode: node
				});
			}

			// 2. Project to other visible images (Green)
			// We need paths from the node's image to all other visible images
			const paths = await ImageGraph.solvePaths(node.imgId, this.cv, this.db);

			for (const p of paths) {
				if (this.visibleIds.has(p.id)) {
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
		// Redraw all to show changes
		Object.values(this.viewers).forEach(v => v.draw());
	}

	async syncCursors(masterId, mx, my) {
		this.cursorState = { masterId, mx, my };

		for(const [id, viewer] of Object.entries(this.viewers)) {
			if(id === masterId) {
				viewer.setDimmed(false);
				viewer.draw();
				continue;
			}

			const path = await ImageGraph.solvePaths(masterId, this.cv, this.db);
			const targetPath = path.find(p => p.id === id);

			if(targetPath) {
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

						let dx = 0; let dy = 0;

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
				viewer.cursorPos = null;
				viewer.setDimmed(true);
			}
			viewer.draw();
		}
	}

	drawOverlay(id, ctx, k) {
		const viewer = this.viewers[id];
		if (!viewer) return;

		const ik = 1/k; // Inverse zoom factor

		// 1. Draw Cached Nodes as Pins
		if (this.netNodeCache[id]) {
			this.netNodeCache[id].forEach(n => {
				let drawX = n.x;
				if (viewer.isMirrored && viewer.bmp) drawX = viewer.bmp.width - n.x;

				ctx.save();
				ctx.translate(drawX, n.y);
				ctx.scale(ik, ik); // Keep pin constant size on screen

				// ROTATION: -45 degrees (Counter-Clockwise)
				// This aligns the "Bottom-Left" corner of our square to point straight down if the square is in the Top-Right quadrant.
				ctx.rotate(-Math.PI / 4);

				// DRAW PIN SHAPE
				// We draw a square relative to the origin (0,0).
				// The Origin (0,0) is the Sharp Tip.
				// The square extends into x>0, y<0 (Visual Top-Right relative to rotation axis)
				// so that when rotated -45deg, it stands "Up" above the point.

				const s = 20; // Size of the square side
				const r = 10; // Radius (50% of size)

				ctx.beginPath();
				ctx.moveTo(0, 0); // Tip starts exactly on the node coordinate

				// Left Edge (going 'Up' in local coords) -> Top-Left Corner
				ctx.lineTo(0, -s + r);
				ctx.arcTo(0, -s, s, -s, r);

				// Top Edge -> Top-Right Corner
				ctx.lineTo(s - r, -s);
				ctx.arcTo(s, -s, s, 0, r);

				// Right Edge -> Bottom-Right Corner
				ctx.lineTo(s, -r);
				ctx.arcTo(s, 0, 0, 0, r);

				// Return to Tip
				ctx.lineTo(0, 0);
				ctx.closePath();

				ctx.fillStyle = n.color; // Blue (#2563eb) or Green (#4ade80)
				ctx.fill();

				// White Border
				ctx.lineWidth = 1.5;
				ctx.strokeStyle = 'white';
				ctx.stroke();

				// LABEL
				// We want the text in the center of the "bulb".
				// The center of our square is at (s/2, -s/2).
				ctx.translate(s/2, -s/2);

				// Rotate text back +45deg so it appears horizontal
				ctx.rotate(Math.PI / 4);

				ctx.fillStyle = 'white';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.font = 'bold 9px sans-serif';
				ctx.fillText(n.label, 0, 0);

				ctx.restore();
			});
		}

		// 2. Cursor Crosshair (Unchanged)
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

	startNewNet() {
		this.activeNet = { id: uuid(), name: "New Net", nodes: [], isNew: true };
		this.updateNetUI();
	}

	async handleAddNode(imgId, x, y) {
		const nextIdx = this.activeNet ? this.activeNet.nodes.length + 1 : 1;
		const defaultLabel = `P${nextIdx}`;

		const label = await requestInput("Add Node", "Pad/Pin Name", defaultLabel);

		if(label) {
			if(!this.activeNet) this.startNewNet();
			this.activeNet.nodes.push({
				id: uuid(), imgId: imgId, x: Math.round(x), y: Math.round(y), label: label
			});
			this.updateNetUI();
			Object.values(this.viewers).forEach(v => v.draw());
		}
	}

	async saveNet() {
		if(!this.activeNet) return;

		// Only prompt for name if it's a new net
		if (this.activeNet.isNew) {
			const name = await requestInput("Save Net", "Net Name", this.activeNet.name);
			if(name) {
				this.activeNet.name = name;
				delete this.activeNet.isNew;
			} else {
				return;
			}
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
