// ── State ─────────────────────────────────────────────────────
// Single mutable app state object.	 All modules share this reference.
export const S = {
	components: [],	 // [{id, ref, value, type, x, y, rotation, flipX, pins:[{name,net}], pcbX, pcbY}]
	nets: [],	 // [{name, nodes:[{ref,pin}], color, isWip}]
	wires: [],	 // [{id, net, points:[{x,y}], pinA, pinB}]

	// Viewport
	viewX: 0, viewY: 0, zoom: 1,

	// Interaction
	dragging: null,	 // {compId, ox, oy}
	wireDrag: null,	 // unused after WireBender migration, kept for compat
	panning: false,
	panStart: null,	 // {x, y, vx, vy}

	// Selection
	selectedComp: null,
	selectedWire: null,	 // {wireId, segIdx, axis}
	selectedNet: null,

	// Hover
	hoverComp: null,
	hoverWireSeg: null,	 // {wireId, segIdx, axis}

	// History (undo)
	history: [],

	// Junction dots — written by layout.js after each route
	junctionPoints: [],	 // [{x, y, net}]

	// Component label hints from WireBender
	componentLabels: {}, // { [compId]: ComponentLabelHint }

	hasData: false,
};

// ── Global constants ─────────────────────────────────────────
export const GRID = 20;		// snap grid, px
export const MARGIN = 10;		// routing clearance around component bodies, px

export const NET_COLORS = [
	'#00e5a0', '#00a8ff', '#ff6b35', '#f0c040', '#a78bfa',
	'#f472b6', '#34d399', '#fb923c', '#60a5fa', '#4ade80',
	'#e879f9', '#2dd4bf', '#fbbf24', '#f87171', '#818cf8',
];

// ── Canvas context (set once by app.js after DOM ready) ───────
export let canvas, ctx;
export function initCanvas(canvasEl) {
	canvas = canvasEl;
	ctx = canvasEl.getContext('2d');
	// console.log('[schema] initCanvas:', canvasEl, 'ctx:', !!ctx);
}

// ── Coordinate helpers ────────────────────────────────────────
export const s2w = (sx, sy) => ({
	x: (sx - canvas.width / 2 - S.viewX) / S.zoom,
	y: (sy - canvas.height / 2 - S.viewY) / S.zoom,
});
export const w2s = (wx, wy) => ({
	x: wx * S.zoom + canvas.width / 2 + S.viewX,
	y: wy * S.zoom + canvas.height / 2 + S.viewY,
});
export const snap = v => Math.round(v / GRID) * GRID;

// ── Net color lookup ──────────────────────────────────────────
export function getNetColor(name) {
	const net = S.nets.find(x => x.name === name);
	if (net?.color) return net.color;
	// Fallback: stable hash so same name always gets same color
	let h = 0;
	for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
	return NET_COLORS[h % NET_COLORS.length];
}
