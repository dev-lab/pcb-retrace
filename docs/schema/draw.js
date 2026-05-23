import { S, canvas, ctx, w2s, getNetColor, GRID } from './state.js';
import { createComp } from './components.js';

// ── Component drawing ─────────────────────────────────────────
// New code:
export function drawComponent(comp) {
	const isSel = S.selectedComp === comp.id;
	const isHov = S.hoverComp		=== comp.id;
	const labelHint = S.componentLabels ? S.componentLabels[comp.id] : null;
	createComp(comp).draw(ctx, isSel, isHov, S.components, S.wires, labelHint);
}

// ── Wire drawing ──────────────────────────────────────────────
// Rendering order (from prototype):
//	 Pass 1 — white halos	 (strokeStyle=white, lineWidth=3.5)
//	 Pass 2 — net colours	 (lineWidth=1.5)
//	 Pass 3 — junction dots
//
// The white halo is critical for readability: it creates a visible
// separation border when wires from different nets run close together.
export function drawWires() {
	// Pass 1: white halos for all wires
	S.wires.forEach(wire => {
		if (!wire.points || wire.points.length < 2) return;
		ctx.strokeStyle = 'white';
		ctx.lineWidth		= 3.5;
		ctx.lineJoin		= 'round';
		ctx.globalAlpha = 0.85;
		ctx.beginPath();
		ctx.moveTo(wire.points[0].x, wire.points[0].y);
		wire.points.forEach((p, i) => { if (i > 0) ctx.lineTo(p.x, p.y); });
		ctx.stroke();
		ctx.globalAlpha = 1;
	});

	// Pass 2: net-coloured lines on top
	S.wires.forEach(wire => {
		if (!wire.points || wire.points.length < 2) return;
		const isWIP			= S.nets.find(n => n.name === wire.net)?.isWip;
		const baseCol		= isWIP ? '#f0c040' : getNetColor(wire.net);
		const isSelNet	= S.selectedNet	 === wire.net;
		const isSelWire = S.selectedWire?.wireId === wire.id;
		const drawCol		= (isSelNet || isSelWire) ? '#ffffff' : baseCol;

		ctx.strokeStyle = drawCol;
		ctx.lineWidth		= (isSelNet || isSelWire) ? 2.5 : 1.5;
		ctx.lineJoin		= 'round';
		ctx.globalAlpha = 0.95;
		ctx.beginPath();
		ctx.moveTo(wire.points[0].x, wire.points[0].y);
		wire.points.forEach((p, i) => { if (i > 0) ctx.lineTo(p.x, p.y); });
		ctx.stroke();
		ctx.globalAlpha = 1;

		// Selected segment highlight
		if (isSelWire) {
			const si = S.selectedWire.segIdx;
			if (si < wire.points.length - 1) {
				ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.globalAlpha = 0.35;
				ctx.beginPath();
				ctx.moveTo(wire.points[si].x,		wire.points[si].y);
				ctx.lineTo(wire.points[si+1].x, wire.points[si+1].y);
				ctx.stroke(); ctx.globalAlpha = 1;
			}
		}

		// Hovered segment highlight
		if (S.hoverWireSeg?.wireId === wire.id) {
			const si = S.hoverWireSeg.segIdx;
			if (si < wire.points.length - 1) {
				ctx.strokeStyle = baseCol; ctx.lineWidth = 3; ctx.globalAlpha = 0.45;
				ctx.beginPath();
				ctx.moveTo(wire.points[si].x,		wire.points[si].y);
				ctx.lineTo(wire.points[si+1].x, wire.points[si+1].y);
				ctx.stroke(); ctx.globalAlpha = 1;
			}
		}
	});

	// Pass 3: junction dots
	_drawJunctions();
}

// ── Junction dots ─────────────────────────────────────────────
// WireBender computes junction positions explicitly and stores
// them in S.junctionPoints after each route.
function _drawJunctions() {
	(S.junctionPoints || []).forEach(({ x, y, net }) => {
		const col = getNetColor(net);
		// Filled circle
		ctx.beginPath();
		ctx.arc(x, y, 4, 0, Math.PI * 2);
		ctx.fillStyle = col;
		ctx.fill();
		// Dark outline for contrast (matches prototype)
		ctx.strokeStyle = '#000';
		ctx.lineWidth		= 1;
		ctx.beginPath();
		ctx.arc(x, y, 4, 0, Math.PI * 2);
		ctx.stroke();
	});
}

// ── Background grid ───────────────────────────────────────────
export function drawGrid() {
	const step = GRID * S.zoom;
	if (step < 8) return;
	const o = w2s(0, 0);
	ctx.strokeStyle = '#1a2130'; ctx.lineWidth = 0.5;
	for (let x = o.x % step; x < canvas.width; x += step) {
		ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
	}
	for (let y = o.y % step; y < canvas.height; y += step) {
		ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
	}
}

// ── Main render ───────────────────────────────────────────────
export function render() {
	// console.log('[schema] render canvas:', canvas?.width, canvas?.height, 'ctx:', !!ctx);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, canvas.width, canvas.height);
	drawGrid();
	ctx.save();
	ctx.translate(canvas.width / 2 + S.viewX, canvas.height / 2 + S.viewY);
	ctx.scale(S.zoom, S.zoom);
	drawWires();
	S.components.forEach(c => drawComponent(c));
	ctx.restore();
	document.getElementById('zoom-ind').textContent = Math.round(S.zoom * 100) + '%';
	document.getElementById('empty-state').style.display = S.hasData ? 'none' : 'flex';
}
