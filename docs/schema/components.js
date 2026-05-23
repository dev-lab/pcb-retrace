// ═══════════════════════════════════════════════════════════════
//	COMPONENT LIBRARY
//
//	Each component type is a class that encapsulates everything
//	specific to that type: geometry, pin layout, WireBender
//	descriptor, and Canvas drawing.	 All external code talks only
//	to the CompBase interface via createComp(stateObj).
//
//	To add a new component type:
//		1. Subclass CompBase
//		2. Override color, label, _buildGeometry(), draw()
//		3. Register in ALL_TYPES at the bottom
//
//	State object shape (S.components[i]):
//		{ id, ref, value, type, x, y, rotation, flipX, pins:[{name,net}], pcbX?, pcbY? }
// ═══════════════════════════════════════════════════════════════

import { MARGIN, getNetColor } from './state.js';

const PIN_PITCH = 20;

// ── WireBender PinDirection flags ─────────────────────────────
// Mirrors Module.PinDirection enum values.
export const PinDir = {
	DirNone: 0,
	DirUp: 1,
	DirDown: 2,
	DirLeft: 4,
	DirRight: 8,
	DirAll: 15,
};

// ── Base class ────────────────────────────────────────────────
export class CompBase {
	constructor(state) {
		// state is the plain object from S.components — we hold a reference,
		// never copy, so mutations (x, y, rotation …) are always live.
		this._s = state;
	}

	// ── Identity / appearance ─────────────────────────────────
	get color() { return '#94a3b8'; }		// override in subclass
	get label() { return this._s.type; } // override in subclass

	// ── Geometry ──────────────────────────────────────────────
	// Returns { w, h, pins:[{name, side:'L'|'R'|'T'|'B', along}] }
	// 'along' = signed offset from the face centre (px).
	// Subclasses implement _buildGeometry(); consumers call geometry().
	_buildGeometry() { throw new Error(`${this.constructor.name}._buildGeometry not implemented`); }

	geometry() {
		// Cache per instance — geometry only changes if the pin list changes,
		// which only happens on netlist reload (new instance created).
		if (!this._geo) this._geo = this._buildGeometry();
		return this._geo;
	}

	// ── Pin local coordinates ─────────────────────────────────
	// Returns pin positions in component-local space:
	//	 origin = component centre, no rotation applied.
	// Both pinPositions() and wbDescriptor() derive from this so
	// they can never diverge.
	//
	// Returns [{gp, ldx, ldy, ex, ey}] where:
	//	 ldx/ldy	= offset from component centre
	//	 ex/ey		= unit outward direction of the stub
	_pinLocalCoords() {
		const geo = this.geometry();
		return geo.pins.map(gp => {
			let ldx, ldy, ex, ey;
			switch (gp.side) {
				case 'L': ldx = -geo.w / 2; ldy = gp.along; ex = -1; ey = 0; break;
				case 'R': ldx = geo.w / 2; ldy = gp.along; ex = 1; ey = 0; break;
				case 'T': ldx = gp.along; ldy = -geo.h / 2; ex = 0; ey = -1; break;
				case 'B': ldx = gp.along; ldy = geo.h / 2; ex = 0; ey = 1; break;
				default: ldx = 0; ldy = 0; ex = 0; ey = 0;
			}
			return { gp, ldx, ldy, ex, ey };
		});
	}

	// ── Pin world-space positions ─────────────────────────────
	// Returns the world-space position of each pin, derived purely
	// from component geometry and rotation.	This is the single source
	// of truth for where pin dots and stubs are drawn.
	//
	// These positions match where WireBender places wire endpoints,
	// because wbDescriptor() uses the same _pinLocalCoords() source.
	// There is no need for a separate _wbX/_wbY back-annotation pass.
	pinPositions() {
		const s		= this._s;
		const rot = (s.rotation || 0) * Math.PI / 180;
		const fx = s.flipX ? -1 : 1;
		const cos = Math.cos(rot), sin = Math.sin(rot);
		const rot2 = (dx, dy) => ({ x: dx * fx * cos - dy * sin, y: dx * fx * sin + dy * cos });

		return this._pinLocalCoords().map(({ gp, ldx, ldy, ex, ey }, i) => {
			const sp = s.pins[i];
			const rp = rot2(ldx, ldy);
			const re = rot2(ex, ey);
			return {
				name: gp.name,
				pinName: sp?.name ?? gp.name,
				x: s.x + rp.x,
				y: s.y + rp.y,
				ex: re.x,
				ey: re.y,
				net: sp?.net ?? null,
				compId: s.id,
			};
		});
	}

	// ── Axis-aligned bounding box (with routing margin) ───────
	bbox() {
		const geo = this.geometry();
		return {
			x1: this._s.x - geo.w / 2 - MARGIN,
			y1: this._s.y - geo.h / 2 - MARGIN,
			x2: this._s.x + geo.w / 2 + MARGIN,
			y2: this._s.y + geo.h / 2 + MARGIN,
		};
	}

	// ── Pin stub length ───────────────────────────────────────
	stubLen(_pinIdx) { return 16; }	 // matches WireBender padding default

	// ── WireBender descriptor ─────────────────────────────────
	// Returns the plain JS object consumed by wb.addComponent().
	// NOTE: pins[] here is a plain array for our internal use;
	// layout.js converts it to a VectorPinDescriptor before handing
	// it to the WASM module.
	//
	wbDescriptor() {
		const geo = this.geometry();
		const s = this._s;
		const lcs = this._pinLocalCoords();

		const SIDE_DIR = {
			L: PinDir.DirLeft,
			R: PinDir.DirRight,
			T: PinDir.DirUp,
			B: PinDir.DirDown,
		};

		const pins = lcs.map(({ gp, ldx, ldy }, i) => {
			const pinName = s.pins[i]?.name ?? gp.name;
			return {
				number: i + 1,
				name: pinName,
				x: ldx,
				y: ldy,
				directionFlags: SIDE_DIR[gp.side] ?? PinDir.DirAll,
			};
		});

		return {
			id: s.id,
			width: geo.w,
			height: geo.h,
			padding: 16,
			pins,
		};
	}

	whTransformed() {
		const geo = this.geometry();
		const q = Math.round((this._s.rotation || 0) / 90) & 1;
		return { w: q ? geo.h : geo.w, h: q ? geo.w : geo.h };
	}

wbDescriptorTransformed() {
		const geo	 = this.geometry();
		const s		 = this._s;
		const lcs	 = this._pinLocalCoords();

		// Snap rotation to nearest 90° step (0, 1, 2, 3 quarter-turns)
		const rot		= s.rotation || 0;
		const fx		= s.flipX ? -1 : 1;
		const steps = Math.round(rot / 90) & 3;	// 0..3
		const cosR	= [1, 0, -1, 0][steps];
		const sinR	= [0, 1, 0, -1][steps];

		// Rotated bounding box: w and h swap at 90°/270°
		const rw = (steps & 1) ? geo.h : geo.w;
		const rh = (steps & 1) ? geo.w : geo.h;

		// Map pin side through rotation (CW on canvas, +Y down)
		const ROTSIDE = { L: ['L','T','R','B'], T:['T','R','B','L'],
											R: ['R','B','L','T'], B:['B','L','T','R'] };

		const SIDE_DIR = {
			L: PinDir.DirLeft,
			R: PinDir.DirRight,
			T: PinDir.DirUp,
			B: PinDir.DirDown,
		};

		const pins = lcs.map(({ gp, ldx, ldy }, i) => {
			let side = gp.side;
			if (s.flipX) {
				if (side === 'L') side = 'R';
				else if (side === 'R') side = 'L';
			}

			// Rotate local coords by `steps` quarter-turns CW.
			// Result is still centre-origin — exactly what WireBender v2 expects.
			const px = cosR * (ldx * fx) - sinR * ldy;
			const py = sinR * (ldx * fx) + cosR * ldy;
			const rotatedSide = ROTSIDE[side]?.[steps] ?? side;
			const pinName = s.pins[i]?.name ?? gp.name;
			return {
				number:					i + 1,
				name:						pinName,
				x:							px,
				y:							py,
				directionFlags: SIDE_DIR[rotatedSide] ?? PinDir.DirAll,
			};
		});

		return {
			id: s.id,
			width: rw,
			height: rh,
			padding: 16,
			pins,
		};
	}

	// ── Drawing ───────────────────────────────────────────────
	// labelHint — optional ComponentLabelHint from WireBender.
	// When provided, pre-computed positions are used directly and the
	// JS-side collision search is skipped entirely.  Pass null/undefined
	// to fall back to the self-contained JS placement logic.
	draw(ctx, isSel, isHov, allComps, allWires, labelHint = null) {
		const geo = this.geometry();
		const col = this.color;
		const s		= this._s;

		// ── Symbol body — rotated ─────────────────────────────
		ctx.save();
		ctx.translate(s.x, s.y);
		ctx.rotate((s.rotation || 0) * Math.PI / 180);
		if (s.flipX) ctx.scale(-1, 1);
		if (isSel) {
			ctx.shadowColor = col; ctx.shadowBlur = 14;
		}
		else if (isHov) { ctx.shadowColor = col; ctx.shadowBlur = 7; }
		this._drawSymbol(ctx, geo, col, isSel);
		ctx.shadowBlur = 0;
		ctx.restore();

		// ── Labels ────────────────────────────────────────────
		this._drawLabels(ctx, geo, col, allComps, allWires, labelHint);

		// ── Stubs and pin dots — world space ──────────────────
		const STUB = 8;
		const pins = this.pinPositions();
		pins.forEach((pin) => {
			const tipX = pin.x + pin.ex * STUB;
			const tipY = pin.y + pin.ey * STUB;

			// Stub: body edge → tip
			ctx.strokeStyle = col + 'c0';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(pin.x, pin.y);
			ctx.lineTo(tipX, tipY);
			ctx.stroke();

			// Pin name label just outside body edge
			ctx.fillStyle = col;
			ctx.font = 'bold 8px Space Mono,monospace';
			ctx.textBaseline = 'middle';
			const lx = pin.x + pin.ex * 2, ly = pin.y + pin.ey * 2;
			ctx.textAlign = pin.ex < -0.5 ? 'right' : pin.ex > 0.5 ? 'left' : 'center';
			ctx.fillText(pin.pinName, lx, ly);

			// Pin dot at stub tip (wire connection point)
			ctx.beginPath();
			ctx.arc(tipX, tipY, 3, 0, Math.PI * 2);
			ctx.fillStyle = pin.net ? getNetColor(pin.net) : '#3d4552';
			ctx.fill();
			if (!pin.net) {
				ctx.strokeStyle = '#3d4552'; ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(tipX - 4, tipY - 4); ctx.lineTo(tipX + 4, tipY + 4);
				ctx.moveTo(tipX + 4, tipY - 4); ctx.lineTo(tipX - 4, tipY + 4);
				ctx.stroke();
			}
		});
	}

	// labelHint is a ComponentLabelHint returned by WireBender (may be null).
	// When present the pre-computed positions are used directly, skipping the
	// JS-side candidate search entirely.  The fallback path (null hint) keeps
	// the original behaviour so the method works before routing has run.
	_drawLabels(ctx, geo, col, allComps, allWires, labelHint = null) {
		const s = this._s;

		// ── Fast path: use WireBender-supplied positions ──────────────────────
		if (labelHint) {
			ctx.font = `bold 10px 'Space Mono',monospace`;
			ctx.fillStyle = col;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(s.ref, labelHint.refPosition.x, labelHint.refPosition.y);

			if (s.value) {
				ctx.font = `9px 'Space Mono',monospace`;
				ctx.fillStyle = 'rgba(230,237,243,0.6)';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(s.value, labelHint.valuePosition.x, labelHint.valuePosition.y);
			}
			return;
		}

		// ── Fallback path: self-contained JS collision search ─────────────────
		// Used before routeAll() has been called (e.g. during initial load or
		// while the WireBender module is still initialising).

		const isColliding = (rect) => {
			const BBOX_INFLATE = 4;
			// 1. Check components
			for (const other of allComps) {
				const otherGeo = createComp(other).geometry();
				const otherRot = (other.rotation || 0) * Math.PI / 180;
				const otherCos = Math.abs(Math.cos(otherRot));
				const otherSin = Math.abs(Math.sin(otherRot));
				const otherW = otherGeo.w * otherCos + otherGeo.h * otherSin;
				const otherH = otherGeo.w * otherSin + otherGeo.h * otherCos;
				const otherRect = {
					x1: other.x - otherW / 2 - BBOX_INFLATE, y1: other.y - otherH / 2 - BBOX_INFLATE,
					x2: other.x + otherW / 2 + BBOX_INFLATE, y2: other.y + otherH / 2 + BBOX_INFLATE,
				};
				if (rect.x1 < otherRect.x2 && rect.x2 > otherRect.x1 &&
					rect.y1 < otherRect.y2 && rect.y2 > otherRect.y1) {
					return true;
				}
			}
			// 2. Check wires
			for (const w of allWires) {
				if (!w.points) continue;
				for (let i = 0; i < w.points.length - 1; i++) {
					const p1 = w.points[i], p2 = w.points[i + 1];
					const minX = Math.min(p1.x, p2.x) - 2;
					const maxX = Math.max(p1.x, p2.x) + 2;
					const minY = Math.min(p1.y, p2.y) - 2;
					const maxY = Math.max(p1.y, p2.y) + 2;
					if (rect.x1 <= maxX && rect.x2 >= minX && rect.y1 <= maxY && rect.y2 >= minY) {
						return true;
					}
				}
			}
			return false;
		};

		const findPosition = (text, textW, textH, candidates, reservedRect = null) => {
			for (const candidate of candidates) {
				const labelRect = {
					x1: candidate.x - textW / 2, y1: candidate.y - textH / 2,
					x2: candidate.x + textW / 2, y2: candidate.y + textH / 2
				};
				if (isColliding(labelRect)) continue;
				if (reservedRect &&
					labelRect.x1 < reservedRect.x2 && labelRect.x2 > reservedRect.x1 &&
					labelRect.y1 < reservedRect.y2 && labelRect.y2 > reservedRect.y1) {
					continue;
				}
				return candidate;
			}
			return candidates[0];
		};

		const rot = (s.rotation || 0) * Math.PI / 180;
		const cosR = Math.abs(Math.cos(rot)), sinR = Math.abs(Math.sin(rot));
		const worldW = geo.w * cosR + geo.h * sinR;
		const worldH = geo.w * sinR + geo.h * cosR;
		const PADDING = 6;

		// --- REF label ---
		ctx.font = `bold 10px 'Space Mono',monospace`;
		const refW = ctx.measureText(s.ref).width;
		const refH = 12;

		const refCandidates = [
			{ x: s.x, y: s.y - worldH / 2 - refH / 2 - PADDING },
			{ x: s.x, y: s.y + worldH / 2 + refH / 2 + PADDING },
			{ x: s.x + worldW / 2 + refW / 2 + PADDING, y: s.y },
			{ x: s.x - worldW / 2 - refW / 2 - PADDING, y: s.y },
			{ x: s.x + worldW / 2 + refW / 2 + PADDING, y: s.y - worldH / 2 },
			{ x: s.x - worldW / 2 - refW / 2 - PADDING, y: s.y - worldH / 2 }
		];
		const refPos = findPosition(s.ref, refW, refH, refCandidates);
		const refRect = { x1: refPos.x - refW / 2, y1: refPos.y - refH / 2, x2: refPos.x + refW / 2, y2: refPos.y + refH / 2 };

		ctx.fillStyle = col;
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.fillText(s.ref, refPos.x, refPos.y);

		// --- VALUE label ---
		if (s.value) {
			ctx.font = `9px 'Space Mono',monospace`;
			const valW = ctx.measureText(s.value).width;
			const valH = 11;

			const valCandidates = [
				{ x: s.x, y: s.y + worldH / 2 + valH / 2 + PADDING },
				{ x: s.x, y: s.y - worldH / 2 - valH / 2 - PADDING },
				{ x: s.x + worldW / 2 + valW / 2 + PADDING, y: s.y },
				{ x: s.x - worldW / 2 - valW / 2 - PADDING, y: s.y },
				{ x: s.x + worldW / 2 + valW / 2 + PADDING, y: s.y + worldH / 2 },
				{ x: s.x - worldW / 2 - valW / 2 - PADDING, y: s.y + worldH / 2 }
			];
			const valPos = findPosition(s.value, valW, valH, valCandidates, refRect);

			ctx.fillStyle = 'rgba(230,237,243,0.6)';
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillText(s.value, valPos.x, valPos.y);
		}
	}

	_drawSymbol(_ctx, _geo, _col, _isSel) {
		throw new Error(`${this.constructor.name}._drawSymbol not implemented`);
	}

	// ── Hit-test ─────────────────────────────────────────────
	hitTest(wx, wy) {
		const geo = this.geometry();
		const s = this._s;
		const hw = geo.w / 2 + 8, hh = geo.h / 2 + 8;
		const rot = -(s.rotation || 0) * Math.Pi / 180;
		const dx = wx - s.x, dy = wy - s.y;
		const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
		const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
		return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
	}
}

// ── Resistor ──────────────────────────────────────────────────
export class ResistorComp extends CompBase {
	static prefixes = ['R'];
	static typeKey = 'R';
	get color() { return '#4ade80'; }
	get label() { return 'RES'; }

	_buildGeometry() {
		const cp = this._s.pins;
		return {
			w: 60, h: 24,
			pins: [
				{ name: cp[0]?.name ?? '1', side: 'L', along: 0 },
				{ name: cp[1]?.name ?? '2', side: 'R', along: 0 },
			],
		};
	}

	_drawSymbol(ctx, g, col, sel) {
		const bw = 28, bh = 12;
		ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.5;
		ctx.fillStyle = 'rgba(0,0,0,0.4)';
		ctx.beginPath();
		ctx.moveTo(-g.w / 2, 0); ctx.lineTo(-bw / 2, 0);
		ctx.moveTo(bw / 2, 0); ctx.lineTo(g.w / 2, 0);
		ctx.stroke();
		ctx.beginPath(); ctx.rect(-bw / 2, -bh / 2, bw, bh);
		ctx.fill(); ctx.stroke();
		ctx.fillStyle = col + '60';
		ctx.fillRect(-4, -bh / 2, 3, bh);
	}
}

// ── Capacitor ─────────────────────────────────────────────────
export class CapacitorComp extends CompBase {
	static prefixes = ['C'];
	static typeKey = 'C';
	get color() { return '#60a5fa'; }
	get label() { return 'CAP'; }

	_buildGeometry() {
		const cp = this._s.pins;
		return {
			w: 28, h: 40,
			pins: [
				{ name: cp[0]?.name ?? '+', side: 'T', along: 0 },
				{ name: cp[1]?.name ?? '-', side: 'B', along: 0 },
			],
		};
	}

	_drawSymbol(ctx, g, col, sel) {
		const gap = 5, pw = 12;
		ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.5;
		ctx.beginPath();
		ctx.moveTo(0, -g.h / 2); ctx.lineTo(0, -gap);
		ctx.moveTo(0, gap); ctx.lineTo(0, g.h / 2);
		ctx.stroke();
		ctx.lineWidth = sel ? 3 : 2;
		ctx.beginPath();
		ctx.moveTo(-pw, -gap); ctx.lineTo(pw, -gap);
		ctx.moveTo(-pw, gap); ctx.lineTo(pw, gap);
		ctx.stroke();
	}
}

// ── Inductor ──────────────────────────────────────────────────
export class InductorComp extends CompBase {
	static prefixes = ['L'];
	static typeKey = 'L';
	get color() { return '#f472b6'; }
	get label() { return 'IND'; }

	_buildGeometry() {
		const cp = this._s.pins;
		return {
			w: 60, h: 20,
			pins: [
				{ name: cp[0]?.name ?? '1', side: 'L', along: 0 },
				{ name: cp[1]?.name ?? '2', side: 'R', along: 0 },
			],
		};
	}

	_drawSymbol(ctx, g, col, sel) {
		ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.5;
		ctx.beginPath();
		ctx.moveTo(-g.w / 2, 0); ctx.lineTo(-22, 0);
		ctx.moveTo(22, 0); ctx.lineTo(g.w / 2, 0);
		ctx.stroke();
		for (let i = 0; i < 4; i++) {
			ctx.beginPath();
			ctx.arc(-16 + i * 11, 0, 6, Math.PI, 0, false);
			ctx.stroke();
		}
	}
}

// ── Diode (base, shared by DiodeComp and ZenerComp) ──────────
class _DiodeBase extends CompBase {
	get color() { return '#fb923c'; }

	_buildGeometry() {
		const cp = this._s.pins;
		return {
			w: 44, h: 24,
			pins: [
				{ name: cp[0]?.name ?? 'A', side: 'L', along: 0 },
				{ name: cp[1]?.name ?? 'K', side: 'R', along: 0 },
			],
		};
	}

	_drawBody(ctx, g, col, sel, isZener) {
		ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.5;
		ctx.fillStyle = col + '40';
		ctx.beginPath();
		ctx.moveTo(-g.w / 2, 0); ctx.lineTo(-10, 0);
		ctx.moveTo(10, 0); ctx.lineTo(g.w / 2, 0);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(-10, -10); ctx.lineTo(-10, 10); ctx.lineTo(10, 0);
		ctx.closePath(); ctx.fill(); ctx.stroke();
		ctx.lineWidth = sel ? 2.5 : 2;
		ctx.beginPath();
		if (isZener) {
			ctx.moveTo(10, -10); ctx.lineTo(10, 10);
			ctx.moveTo(10, -10); ctx.lineTo(14, -14);
			ctx.moveTo(10, 10); ctx.lineTo(6, 14);
		} else {
			ctx.moveTo(10, -10); ctx.lineTo(10, 10);
		}
		ctx.stroke();
	}
}

export class DiodeComp extends _DiodeBase {
	static prefixes = ['D', 'LED'];
	static typeKey = 'D';
	get label() { return 'DIO'; }
	_drawSymbol(ctx, g, col, sel) { this._drawBody(ctx, g, col, sel, false); }
}

export class ZenerComp extends _DiodeBase {
	static prefixes = ['Z'];
	static typeKey = 'Z';
	get label() { return 'ZEN'; }
	_drawSymbol(ctx, g, col, sel) { this._drawBody(ctx, g, col, sel, true); }
}

// ── Generic IC box ────────────────────────────────────────────
export class ICComp extends CompBase {
	static prefixes = [];				// catch-all — matched when no other class claims the prefix
	static typeKey = 'IC';
	get color() { return '#a78bfa'; }
	get label() { return 'IC'; }

	_buildGeometry() {
		const cp = this._s.pins;
		const pc = cp.length;
		const pL = Math.ceil(pc / 2), pR = Math.floor(pc / 2);
		const rows = Math.max(pL, pR);
		// Force odd slot count so centre slot has along=0
		const slots = rows % 2 === 0 ? rows + 1 : rows;
		const midSlot = Math.floor(slots / 2);
		const alongOf = i => (i - midSlot) * PIN_PITCH;
		const h = Math.max(60, (slots + 1) * PIN_PITCH);
		const w = 80;

		const pins = [];
		cp.forEach((p, i) => {
			if (i < pL) {
				pins.push({ name: p.name, side: 'L', along: alongOf(i) });
			} else {
				const j = i - pL;
				pins.push({ name: p.name, side: 'R', along: alongOf(pL - 1 - j) });
			}
		});
		return { w, h, pins };
	}

	_drawSymbol(ctx, g, col, sel) {
		ctx.strokeStyle = col;
		ctx.fillStyle = 'rgba(167,139,250,0.07)';
		ctx.lineWidth = sel ? 2 : 1.5;
		ctx.beginPath(); ctx.rect(-g.w / 2, -g.h / 2, g.w, g.h);
		ctx.fill(); ctx.stroke();
		// Orientation notch
		ctx.beginPath(); ctx.arc(0, -g.h / 2, 5, 0, Math.PI, false);
		ctx.strokeStyle = col + '50'; ctx.stroke();
		// Pin labels inside box
		ctx.lineWidth = 1;
		g.pins.forEach((gp, i) => {
			const name = this._s.pins[i]?.name ?? gp.name;
			if (gp.side === 'L') {
				const px = -g.w / 2, py = gp.along;
				ctx.fillStyle = col + '90'; ctx.font = '7px Space Mono,monospace';
				ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
				ctx.fillText(name, px + 3, py);
			} else {
				const px = g.w / 2, py = gp.along;
				ctx.fillStyle = col + '90'; ctx.font = '7px Space Mono,monospace';
				ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
				ctx.fillText(name, px - 3, py);
			}
		});
	}
}

// ── KiCad Imported Symbol ─────────────────────────────────────
const KICAD_SCALE = 20 / 2.54;

export class KiCadComp extends CompBase {
	static prefixes = [];
	static typeKey = 'KICAD';
	get color() { return '#f0c040'; }
	get label() { return this._s.kicadData?.name || 'KICAD'; }

	_buildGeometry() {
		let minX = 0, minY = 0, maxX = 0, maxY = 0;
		const data = this._s.kicadData;
		if (data && data.pins) {
			data.pins.forEach(p => {
				minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
				minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
			});
		}
		return { w: Math.max(40, maxX - minX + 20), h: Math.max(40, maxY - minY + 20), pins: [] };
	}

	_pinLocalCoords() {
		if (!this._s.kicadData || !this._s.kicadData.pins) return [];
		// Map over logical footprint pins, fetching the assigned physical KiCad pin geometry
		return this._s.pins.map((sp, i) => {
			const p = this._s.kicadData.pins.find(kp => kp.num === sp.name)
				|| this._s.kicadData.pins.find(kp => kp.name === sp.name)
				|| this._s.kicadData.pins[i]; // fallback

			if (!p) return { gp: { name: sp.name, num: sp.name }, ldx: 0, ldy: 0, ex: 1, ey: 0 };

			let ex = 0, ey = 0, a = p.angle || 0;
			if (a === 0) { ex = -1; ey = 0; }
			else if (a === 90) { ex = 0; ey = 1; }
			else if (a === 180) { ex = 1; ey = 0; }
			else if (a === 270) { ex = 0; ey = -1; }
			return { gp: { name: p.name, num: p.num }, ldx: p.x, ldy: p.y, ex, ey };
		});
	}

	wbDescriptor() {
		const geo = this.geometry();
		const s = this._s;
		const lcs = this._pinLocalCoords();

		const pins = lcs.map(({ gp, ldx, ldy, ex, ey }, i) => {
			let dir = 15; // DirAll
			if (ex < -0.5) dir = 4; else if (ex > 0.5) dir = 8;
			else if (ey < -0.5) dir = 1; else if (ey > 0.5) dir = 2;

			// Number must be 1-based index (i+1) to align perfectly with the footprint pins
			return { number: i + 1, name: s.pins[i]?.name || gp.name || String(gp.num), x: ldx, y: ldy, directionFlags: dir };
		});
		return { id: s.id, width: geo.w, height: geo.h, padding: 16, pins };
	}

	wbDescriptorTransformed() {
		const geo = this.geometry();
		const s = this._s;
		const lcs = this._pinLocalCoords();
		const rot = s.rotation || 0;
		const fx = s.flipX ? -1 : 1;
		const steps = Math.round(rot / 90) & 3;
		const cosR = [1, 0, -1, 0][steps];
		const sinR = [0, 1, 0, -1][steps];
		const rw = (steps & 1) ? geo.h : geo.w;
		const rh = (steps & 1) ? geo.w : geo.h;

		const pins = lcs.map(({ gp, ldx, ldy, ex, ey }, i) => {
			const px = cosR * (ldx * fx) - sinR * ldy;
			const py = sinR * (ldx * fx) + cosR * ldy;
			const rex = cosR * (ex * fx) - sinR * ey;
			const rey = sinR * (ex * fx) + cosR * ey;

			let dir = 15; // DirAll
			if (rex < -0.5) dir = 4; else if (rex > 0.5) dir = 8;
			else if (rey < -0.5) dir = 1; else if (rey > 0.5) dir = 2;

			// Number must be 1-based index (i+1) to align perfectly with the footprint pins
			return { number: i + 1, name: s.pins[i]?.name || gp.name || String(gp.num), x: px, y: py, directionFlags: dir };
		});
		return { id: s.id, width: rw, height: rh, padding: 16, pins };
	}

	_drawSymbol(ctx, g, col, sel) {
		const data = this._s.kicadData;
		if (!data) return;

		ctx.strokeStyle = col;
		ctx.lineWidth = sel ? 2 : 1.5;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';

		(data.graphics || []).forEach(node => {
			if (!Array.isArray(node)) return;
			const tag = node[0];

			const ptsNode = node.find(x => Array.isArray(x) && x[0] === 'pts');
			const pts = [];
			if (ptsNode) {
				for (let i = 1; i < ptsNode.length; i++) {
					if (ptsNode[i][0] === 'xy') pts.push({ x: parseFloat(ptsNode[i][1]) * KICAD_SCALE, y: -parseFloat(ptsNode[i][2]) * KICAD_SCALE });
				}
			}

			ctx.beginPath();
			if (tag === 'polyline' && pts.length > 0) {
				ctx.moveTo(pts[0].x, pts[0].y);
				for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
				ctx.stroke();
			} else if (tag === 'rectangle') {
				const start = node.find(x => Array.isArray(x) && x[0] === 'start');
				const end = node.find(x => Array.isArray(x) && x[0] === 'end');
				if (start && end) {
					const sx = parseFloat(start[1]) * KICAD_SCALE, sy = -parseFloat(start[2]) * KICAD_SCALE;
					const ex = parseFloat(end[1]) * KICAD_SCALE, ey = -parseFloat(end[2]) * KICAD_SCALE;
					ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
					ctx.stroke();
				}
			} else if (tag === 'circle') {
				const center = node.find(x => Array.isArray(x) && x[0] === 'center');
				const radius = node.find(x => Array.isArray(x) && x[0] === 'radius');
				if (center && radius) {
					ctx.arc(parseFloat(center[1]) * KICAD_SCALE, -parseFloat(center[2]) * KICAD_SCALE, parseFloat(radius[1]) * KICAD_SCALE, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
		});

		// KiCad pin lines
		data.pins.forEach(p => {
			let dx = 0, dy = 0;
			if (p.angle === 0) dx = p.len;
			else if (p.angle === 90) dy = -p.len;
			else if (p.angle === 180) dx = -p.len;
			else if (p.angle === 270) dy = p.len;
			ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + dx, p.y + dy); ctx.stroke();
		});
	}

	draw(ctx, isSel, isHov, allComps, allWires, labelHint = null) {
		const geo = this.geometry(); const col = this.color; const s = this._s;
		ctx.save(); ctx.translate(s.x, s.y); ctx.rotate((s.rotation || 0) * Math.PI / 180);
		if (s.flipX) ctx.scale(-1, 1);
		if (isSel) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
		else if (isHov) { ctx.shadowColor = col; ctx.shadowBlur = 7; }
		this._drawSymbol(ctx, geo, col, isSel);
		ctx.shadowBlur = 0; ctx.restore();

		this._drawLabels(ctx, geo, col, allComps, allWires, labelHint);

		this.pinPositions().forEach(pin => {
			ctx.fillStyle = col; ctx.font = 'bold 8px Space Mono,monospace'; ctx.textBaseline = 'middle';
			ctx.textAlign = pin.ex < -0.5 ? 'right' : pin.ex > 0.5 ? 'left' : 'center';
			ctx.fillText(pin.pinName, pin.x + pin.ex * 4, pin.y + pin.ey * 4);
			ctx.beginPath(); ctx.arc(pin.x, pin.y, 3, 0, Math.PI * 2);
			ctx.fillStyle = pin.net ? getNetColor(pin.net) : '#3d4552'; ctx.fill();
			if (!pin.net) {
				ctx.strokeStyle = '#3d4552'; ctx.lineWidth = 1; ctx.beginPath();
				ctx.moveTo(pin.x - 4, pin.y - 4); ctx.lineTo(pin.x + 4, pin.y + 4);
				ctx.moveTo(pin.x + 4, pin.y - 4); ctx.lineTo(pin.x - 4, pin.y + 4); ctx.stroke();
			}
		});
	}
}

// ── Registry & factory ────────────────────────────────────────
// ALL_TYPES is the single authoritative list of component classes.
// To add a new type: define the class above with static
// prefixes/typeKey, then append it here.
const ALL_TYPES = [
	ResistorComp,
	CapacitorComp,
	InductorComp,
	DiodeComp,
	ZenerComp,
	KiCadComp,
	ICComp,		// must be last — it is the catch-all (prefixes = [])
];

// typeKey → class	(e.g. 'R' → ResistorComp)
const _byType = new Map(ALL_TYPES.map(Cls => [Cls.typeKey, Cls]));

// Sorted prefix list: longest first so 'LED' matches before 'L'.
const _byPrefix = ALL_TYPES
	.flatMap(Cls => Cls.prefixes.map(p => ({ prefix: p, typeKey: Cls.typeKey })))
	.sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * createComp(stateObj) → CompBase instance
 * Wraps a plain state object with the correct component class.
 */
export function createComp(state) {
	const Cls = _byType.get(state.type) ?? ICComp;
	return new Cls(state);
}

/**
 * classifyComp(ref) → typeKey string
 * Derives a component type from its reference designator.
 */
export function classifyComp(ref) {
	const u = ref.toUpperCase();
	for (const { prefix, typeKey } of _byPrefix)
		if (u.startsWith(prefix)) return typeKey;
	return ICComp.typeKey;
}

export const resolvePin = (comp, ndPin) => {
	const pins = createComp(comp).pinPositions();
	const idx = comp.pins.findIndex(p => p.name === ndPin || p.name === String(ndPin));
	return { pin: pins[idx >= 0 ? idx : 0], idx: idx >= 0 ? idx : 0 };
};

export const compColor = type => createComp({ type, pins: [] }).color;
export const compLabel = type => createComp({ type, pins: [] }).label;
export const compGeometry = comp => createComp(comp).geometry();
export const getPinPositions = comp => createComp(comp).pinPositions();
export const compBBox = comp => createComp(comp).bbox();
export const pinStubLen = (comp, idx) => createComp(comp).stubLen(idx);

