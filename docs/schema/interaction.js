// ── Interaction ───────────────────────────────────────────────
import { db } from './db.js';
import { S, canvas, s2w, snap } from './state.js';
import { compGeometry } from './components.js';
import { routeWires, fitView, moveComponentRoute } from './layout.js';
import { render } from './draw.js';
import { pushHistory, undo } from './history.js';
import {
	showProperties, showNetProperties,
	showDefaultProps, updateSidePanels, toast,
} from './ui.js';

// Autosave callbacks injected by app.js
let _saveComponentLayout = null;
let _saveViewport = null;

// ── Hit testing ───────────────────────────────────────────────
export function hitTestComp(wx, wy) {
	for (const c of [...S.components].reverse()) {
		const g = compGeometry(c);
		const hw = g.w / 2 + 8, hh = g.h / 2 + 8;
		const rot = -(c.rotation || 0) * Math.PI / 180;
		const dx = wx - c.x, dy = wy - c.y;
		const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
		const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
		if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return c;
	}
	return null;
}

export function hitTestWire(wx, wy) {
	// Returns the net name of the first wire hit, or null.
	const THRESH = 6 / S.zoom;
	for (const wire of [...S.wires].reverse()) {
		for (let i = 0; i < wire.points.length - 1; i++) {
			const a = wire.points[i], b = wire.points[i + 1];
			const isH = Math.abs(a.y - b.y) < 1;
			const isV = Math.abs(a.x - b.x) < 1;
			if (isH) {
				const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
				if (Math.abs(wy - a.y) < THRESH && wx >= lo - THRESH && wx <= hi + THRESH)
					return wire.net;
			} else if (isV) {
				const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
				if (Math.abs(wx - a.x) < THRESH && wy >= lo - THRESH && wy <= hi + THRESH)
					return wire.net;
			}
		}
	}
	return null;
}

// ── Context menu ──────────────────────────────────────────────
// A lightweight DOM context menu that works on both desktop
// (right-click) and touch (long-press, handled below).
let _ctxMenu = null;

function _hideContextMenu() {
	if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function _showContextMenu(screenX, screenY, comp) {
	_hideContextMenu();

	const menu = document.createElement('div');
	menu.id = 'ctx-menu';
	menu.style.cssText = `
		position:fixed; left:${screenX}px; top:${screenY}px;
		background:var(--surface); border:1px solid var(--border);
		border-radius:6px; padding:4px 0; z-index:500; min-width:160px;
		font-family:'Space Mono',monospace; font-size:11px;
		box-shadow:0 4px 20px rgba(0,0,0,.5);
	`;

	const items = [
		{ label: '↺ Rotate −90°', action: () => _rotateComp(comp, { rotation: 270, flipX: false }) },
		{ label: '↻ Rotate 90°', action: () => _rotateComp(comp, { rotation: 90, flipX: false }) },
		{ label: '↕ Rotate 180°', action: () => _rotateComp(comp, { rotation: 180, flipX: false }) },
		{ label: '↕ Mirror Vertically', action: () => _rotateComp(comp, { rotation: 180, flipX: true }) },
		{ label: '↔ Mirror Horizontally', action: () => _rotateComp(comp, { rotation: 0, flipX: true }) },
		{ label: '⟳ Reset rotation', action: () => _rotateComp(comp, d4delta({ rotation: comp.rotation, flipX: comp.flipX }, { rotation: 0, flipX: 0 })) },
		{
			label: '✨ Replace Symbol...', action: () => {
				import('./ui.js').then(m => m.showReplaceSymbolModal(comp));
			}
		},
	];

	if (comp.type === 'KICAD') {
		items.push({
			label: '↺ Reset to Default Symbol', action: () => {
				pushHistory();
				import('./components.js').then(async ({ classifyComp }) => {
					comp.type = classifyComp(comp.ref);
					comp.componentTypeId = null;
					comp.kicadData = null;
					// Reset pin names to standard sequential numbers
					comp.pins.forEach((p, i) => { p.name = String(i + 1); });

					await routeWires();
					if (_saveComponentLayout) _saveComponentLayout(comp.id);
					import('./ui.js').then(m => {
						m.toast('Reset to default symbol');
						m.showProperties(comp);
						m.updateSidePanels();
					});
				});
			}
		});
	}

	items.forEach(({ label, action }) => {
		const item = document.createElement('div');
		item.textContent = label;
		item.style.cssText = `
			padding:7px 14px; cursor:pointer; color:var(--text);
			transition:background .1s;
		`;
		item.onmouseenter = () => { item.style.background = 'var(--surface2)'; item.style.color = 'var(--accent)'; };
		item.onmouseleave = () => { item.style.background = ''; item.style.color = 'var(--text)'; };
		item.onclick = () => { _hideContextMenu(); action(); };
		menu.appendChild(item);
	});

	document.body.appendChild(menu);
	_ctxMenu = menu;

	// Clamp to viewport
	const r = menu.getBoundingClientRect();
	if (r.right > window.innerWidth) menu.style.left = (screenX - r.width) + 'px';
	if (r.bottom > window.innerHeight) menu.style.top = (screenY - r.height) + 'px';

	// Close on next click anywhere
	setTimeout(() => document.addEventListener('click', _hideContextMenu, { once: true }), 0);
}

function d4inverse(t) {
	const r = t.rotation || 0;
	if (!t.flipX)
		return { rotation: (360 - r) % 360, flipX: false };
	else
		return { rotation: r, flipX: true };
}

function d4compose(a, b) {
	const rA = a.rotation || 0;
	const rB = b.rotation || 0;
	const fB = b.flipX || false;

	if (!a.flipX)
		return { rotation: (rA + rB) % 360, flipX: fB };
	else
		return { rotation: (rA + (360 - rB)) % 360, flipX: !fB };
}

function d4delta(current, target) {
	// Delta to reach target is solved via extrinsic composition: Δ * C = T => Δ = T * C^-1
	return d4compose(target, d4inverse(current));
}

function _rotateComp(comp, delta) {
	pushHistory();
	const prev = { rotation: comp.rotation || 0, flipX: comp.flipX || false };
	// Swap compose order: Δ * prev applies transformations extrinsically (in world space)
	const next = d4compose(delta, prev);
	comp.rotation = next.rotation;
	comp.flipX = next.flipX;
	showProperties(comp);
	updateSidePanels();
	moveComponentRoute(comp.id).then(() => {
		if (_saveComponentLayout) _saveComponentLayout(comp.id);
	});
}

// ── Touch long-press for context menu ─────────────────────────
let _longPressTimer = null;
let _longPressComp = null;

function _cancelLongPress() {
	if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
}

// ── Mouse event listeners ─────────────────────────────────────
let _mouseDown = false;
let _didDrag = false;		// distinguish click from drag on mouseup

export function initInteraction(saveComponentLayout, saveViewport) {
	_saveComponentLayout = saveComponentLayout || null;
	_saveViewport = saveViewport || null;

	// ── mousedown ──────────────────────────────────────────────
	canvas.addEventListener('mousedown', e => {
		document.getElementById('left-panel')?.classList.remove('open');
		// {
		//	const w = s2w(e.offsetX, e.offsetY);
		//	console.log('[schema] mousedown world:', w.x, w.y,
		//		'components:', S.components.map(c => `${c.ref}(${Math.round(c.x)},${Math.round(c.y)})`).join(' '));
		// }
		_hideContextMenu();
		_mouseDown = true;
		_didDrag = false;

		// Middle-button or alt+left → pan
		if (e.button === 1 || e.button === 2 || e.altKey) {
			S.panning = true;
			S.panStart = { x: e.offsetX, y: e.offsetY, vx: S.viewX, vy: S.viewY };
			return;
		}

		const w = s2w(e.offsetX, e.offsetY);
		const hC = hitTestComp(w.x, w.y);
		if (hC) {
			S.selectedComp = hC.id; S.selectedNet = null; S.selectedWire = null;
			pushHistory();
			S.dragging = { compId: hC.id, ox: w.x - hC.x, oy: w.y - hC.y };
			showProperties(hC); updateSidePanels(); render();
			return;
		}

		// Click on wire → select whole net
		const hitNet = hitTestWire(w.x, w.y);
		if (hitNet) {
			const net = S.nets.find(n => n.name === hitNet);
			S.selectedNet = hitNet;
			S.selectedComp = null; S.selectedWire = null;
			if (net) showNetProperties(net);
			updateSidePanels(); render();
			return;
		}

		// Click on empty canvas → pan (left-button drag on empty space)
		S.panning = true;
		S.panStart = { x: e.offsetX, y: e.offsetY, vx: S.viewX, vy: S.viewY };
		S.selectedComp = null; S.selectedNet = null; S.selectedWire = null;
		showDefaultProps(); updateSidePanels(); render();
	});

	// ── mousemove ─────────────────────────────────────────────
	canvas.addEventListener('mousemove', e => {
		const w = s2w(e.offsetX, e.offsetY);
		document.getElementById('coord-readout').textContent =
			`X: ${Math.round(w.x)}	Y: ${Math.round(w.y)}`;

		if (S.panning && _mouseDown) {
			const dx = e.offsetX - S.panStart.x;
			const dy = e.offsetY - S.panStart.y;
			if (Math.abs(dx) > 2 || Math.abs(dy) > 2) _didDrag = true;
			S.viewX = S.panStart.vx + dx;
			S.viewY = S.panStart.vy + dy;
			canvas.style.cursor = 'grabbing';
			render(); return;
		}

		if (S.dragging && _mouseDown) {
			_didDrag = true;
			const c = S.components.find(x => x.id === S.dragging.compId);
			if (!c) return;
			c.x = snap(w.x - S.dragging.ox);
			c.y = snap(w.y - S.dragging.oy);
			render(); return;
		}

		// Hover — cursor only, no hint bar for wires (they're not draggable)
		const hC = hitTestComp(w.x, w.y);
		const hW = hC ? null : hitTestWire(w.x, w.y);

		const prevHoverComp = S.hoverComp;
		S.hoverComp = hC ? hC.id : null;
		S.hoverWireSeg = null;	 // no longer tracking individual segments

		const newCursor = hC ? 'move' : hW ? 'pointer' : 'default';
		if (canvas.style.cursor !== newCursor) canvas.style.cursor = newCursor;

		if (S.hoverComp !== prevHoverComp) render();
	});

	// ── mouseup ───────────────────────────────────────────────
	canvas.addEventListener('mouseup', e => {
		_mouseDown = false;
		if (S.dragging) {
			const movedId = S.dragging.compId;
			S.dragging = null;
			moveComponentRoute(movedId).then(() => {
				if (_saveComponentLayout) _saveComponentLayout(movedId);
			});
			return;
		}
		if (S.panning) {
			canvas.style.cursor = 'default';
			S.panning = false;
			S.panStart = null;
			if (_saveViewport) _saveViewport();
		}
	});

	// ── mouseleave ────────────────────────────────────────────
	canvas.addEventListener('mouseleave', () => {
		if (S.dragging) {
			const movedId = S.dragging.compId;
			S.dragging = null;
			moveComponentRoute(movedId).then(() => {
				if (_saveComponentLayout) _saveComponentLayout(movedId);
			});
		}
		if (S.panning) {
			S.panning = false; S.panStart = null;
			canvas.style.cursor = 'default';
			if (_saveViewport) _saveViewport();
		}
		_mouseDown = false;
	});

	// ── Right-click context menu ──────────────────────────────
	canvas.addEventListener('contextmenu', e => {
		e.preventDefault();
		const w = s2w(e.offsetX, e.offsetY);
		const hC = hitTestComp(w.x, w.y);
		if (hC) {
			S.selectedComp = hC.id;
			showProperties(hC); updateSidePanels(); render();
			_showContextMenu(e.clientX, e.clientY, hC);
		}
	});

// ── Touch interaction (Pan, Zoom, Tap, Drag) ─────────────────
	let _touchDist = null;
	let _touchStartPt = null;
	let _touchDragType = null; // 'pan', 'comp', or 'zoom'
	let _touchMoved = false;

	function getPinchDist(e) {
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	canvas.addEventListener('touchstart', e => {
		e.preventDefault(); // Stop simulated mouse events & browser scrolling
		document.getElementById('left-panel')?.classList.remove('open');
		_hideContextMenu();

		if (e.touches.length === 2) {
			_cancelLongPress();
			S.dragging = null;
			_touchDist = getPinchDist(e);
			_touchDragType = 'zoom';
			return;
		}

		if (e.touches.length === 1) {
			_touchMoved = false;
			const t = e.touches[0];
			const rect = canvas.getBoundingClientRect();
			const cx = t.clientX - rect.left;
			const cy = t.clientY - rect.top;
			_touchStartPt = { cx, cy, vx: S.viewX, vy: S.viewY };

			const w = s2w(cx, cy);
			const hC = hitTestComp(w.x, w.y);

			if (hC) {
				_touchDragType = 'comp';
				pushHistory();
				S.dragging = { compId: hC.id, ox: w.x - hC.x, oy: w.y - hC.y };
				_longPressComp = hC;
				_longPressTimer = setTimeout(() => {
					_longPressComp = null;
					_touchDragType = null; // Cancel drag if long press activates
					S.dragging = null;
					S.selectedComp = hC.id;
					showProperties(hC); updateSidePanels(); render();
					_showContextMenu(t.clientX, t.clientY, hC);
				}, 600);
			} else {
				_touchDragType = 'pan';
			}
		}
	}, { passive: false });

	canvas.addEventListener('touchmove', e => {
		e.preventDefault();

		if (e.touches.length === 2 && _touchDragType === 'zoom') {
			const newDist = getPinchDist(e);
			const factor = newDist / _touchDist;
			_touchDist = newDist;

			const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - canvas.getBoundingClientRect().left;
			const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - canvas.getBoundingClientRect().top;
			const w = s2w(cx, cy);

			S.zoom = Math.max(0.1, Math.min(8, S.zoom * factor));
			const ns = {
				x: w.x * S.zoom + canvas.width / 2 + S.viewX,
				y: w.y * S.zoom + canvas.height / 2 + S.viewY,
			};
			S.viewX += cx - ns.x;
			S.viewY += cy - ns.y;

			render();
			return;
		}

		if (e.touches.length === 1 && _touchStartPt) {
			const t = e.touches[0];
			const rect = canvas.getBoundingClientRect();
			const cx = t.clientX - rect.left;
			const cy = t.clientY - rect.top;
			const dx = cx - _touchStartPt.cx;
			const dy = cy - _touchStartPt.cy;

			if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
				_touchMoved = true;
				_cancelLongPress();
			}

			if (_touchDragType === 'pan') {
				S.viewX = _touchStartPt.vx + dx;
				S.viewY = _touchStartPt.vy + dy;
				render();
			} else if (_touchDragType === 'comp' && S.dragging) {
				const w = s2w(cx, cy);
				const c = S.components.find(x => x.id === S.dragging.compId);
				if (c) {
					c.x = snap(w.x - S.dragging.ox);
					c.y = snap(w.y - S.dragging.oy);
					render();
				}
			}
		}
	}, { passive: false });

	canvas.addEventListener('touchend', e => {
		e.preventDefault();
		_cancelLongPress();

		if (e.touches.length === 0) {
			if (!_touchMoved && _touchDragType) {
				// Finger was lifted without dragging -> Tap
				const w = s2w(_touchStartPt.cx, _touchStartPt.cy);
				const hC = hitTestComp(w.x, w.y);
				if (hC) {
					S.selectedComp = hC.id; S.selectedNet = null; S.selectedWire = null;
					showProperties(hC); updateSidePanels(); render();
				} else {
					const hitNet = hitTestWire(w.x, w.y);
					if (hitNet) {
						const net = S.nets.find(n => n.name === hitNet);
						S.selectedNet = hitNet;
						S.selectedComp = null; S.selectedWire = null;
						if (net) showNetProperties(net);
						updateSidePanels(); render();
					} else {
						S.selectedComp = null; S.selectedNet = null; S.selectedWire = null;
						showDefaultProps(); updateSidePanels(); render();
					}
				}
				S.dragging = null; // Prevent backend routing on simple tap
			} else {
				// Drag finished
				if (_touchDragType === 'comp' && S.dragging) {
					const movedId = S.dragging.compId;
					moveComponentRoute(movedId).then(() => {
						if (_saveComponentLayout) _saveComponentLayout(movedId);
					});
				} else if ((_touchDragType === 'pan' || _touchDragType === 'zoom') && _saveViewport) {
					_saveViewport();
				}
			}
			S.dragging = null;
			_touchDragType = null;
			_touchStartPt = null;
			_touchDist = null;
		} else if (e.touches.length === 1) {
			// Dropped from 2 fingers to 1 (finished pinching)
			_touchDragType = null;
			S.dragging = null;
			if (_saveViewport) _saveViewport();
		}
	}, { passive: false });

	canvas.addEventListener('touchcancel', e => {
		e.preventDefault();
		_cancelLongPress();
		S.dragging = null;
		_touchDragType = null;
		_touchStartPt = null;
		_touchDist = null;
	}, { passive: false });

	// ── Wheel — zoom toward pointer, pan with trackpad scroll ──
	canvas.addEventListener('wheel', e => {
		e.preventDefault();

		// Two-finger trackpad pan: small deltas without ctrlKey = scroll, not pinch
		if (!e.ctrlKey && e.deltaMode === 0 &&
			(Math.abs(e.deltaX) > 2 || Math.abs(e.deltaY) < 50)) {
			S.viewX -= e.deltaX;
			S.viewY -= e.deltaY;
			render();
			if (_saveViewport) _saveViewport();
			return;
		}

		// Zoom toward the pointer position (standard for diagram editors)
		const factor = (e.deltaY < 0 || (e.ctrlKey && e.deltaY < 0)) ? 1.12 : 1 / 1.12;
		const w = s2w(e.offsetX, e.offsetY);
		S.zoom = Math.max(0.1, Math.min(8, S.zoom * factor));
		const ns = {
			x: w.x * S.zoom + canvas.width / 2 + S.viewX,
			y: w.y * S.zoom + canvas.height / 2 + S.viewY,
		};
		S.viewX += e.offsetX - ns.x;
		S.viewY += e.offsetY - ns.y;
		render();
		if (_saveViewport) _saveViewport();
	}, { passive: false });

	// ── Keyboard shortcuts ─────────────────────────────────────
	document.addEventListener('keydown', e => {
		if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
		_hideContextMenu();

		if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
			undo(); return;
		}
		if (e.key === 'f' || e.key === 'F') {
			fitView(); return;
		}
		if ((e.key === 'r' || e.key === 'R') && S.selectedComp) {
			const c = S.components.find(x => x.id === S.selectedComp);
			if (c) _rotateComp(c, { rotation: 270, flipX: false });
			return;
		}
		if ((e.key === 'y' || e.key === 'Y') && S.selectedComp) {
			const c = S.components.find(x => x.id === S.selectedComp);
			if (c) _rotateComp(c, { rotation: 180, flipX: true });
			return;
		}
		if ((e.key === 'x' || e.key === 'X') && S.selectedComp) {
			const c = S.components.find(x => x.id === S.selectedComp);
			if (c) _rotateComp(c, { rotation: 0, flipX: true });
			return;
		}
		if (e.key === 'Escape') {
			_hideContextMenu();
			S.selectedComp = null; S.selectedWire = null; S.selectedNet = null;
			showDefaultProps(); updateSidePanels(); render();
		}
	});
}
