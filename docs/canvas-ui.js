/* canvas-ui.js - Shared Canvas Logic (Mobile/Touch Ready + Resize Hook) */

class PanZoomCanvas {
	constructor(id, onDraw, onClick, onDragPt) {
		this.canvas = document.getElementById(id);
		this.container = this.canvas ? this.canvas.parentElement : null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.bmp = null;

		this.t = {x:0, y:0, k:1};

		this.lm = {x:0, y:0};
		this.activePtIdx = -1;
		this.isMirrored = false;

		this.onDraw = onDraw;
		this.onClick = onClick;
		this.onDragPt = onDragPt;
		this.onMouseMove = null;
		this.onPointerDown = null;

		// New: Resize Callback hook
		this.onResize = null;

		this.evCache = [];
		this.prevDiff = -1;
		this.isDragging = false;
		this.totalDragDist = 0;

		if(this.container) {
			new ResizeObserver(() => {
				if(this.container && this.container.clientWidth > 0) {
					this.canvas.width = this.container.clientWidth;
					this.canvas.height = this.container.clientHeight;
					this.draw();
					// Trigger Hook
					if (this.onResize) this.onResize(this.canvas.width, this.canvas.height);
				}
			}).observe(this.container);
			this.initEvents();
		}
	}

	initEvents() {
		this.canvas.style.touchAction = 'none';

		this.canvas.addEventListener('wheel', e => {
			e.preventDefault();
			const f = Math.exp(-e.deltaY * 0.001);
			this.zoomAt(e.clientX, e.clientY, f);
		}, { passive: false });

		this.canvas.addEventListener('pointerdown', e => this.handlePointerDown(e));
		this.canvas.addEventListener('pointermove', e => this.handlePointerMove(e));
		this.canvas.addEventListener('pointerup', e => this.handlePointerUp(e));
		this.canvas.addEventListener('pointercancel', e => this.handlePointerUp(e));
		this.canvas.addEventListener('pointerout', e => this.handlePointerUp(e));
		this.canvas.addEventListener('pointerleave', e => this.handlePointerUp(e));

		this.canvas.addEventListener('contextmenu', e => {
			const coords = this.getImgCoords(e.clientX, e.clientY);
			if (this.onDragPt) this.onDragPt(coords.x, coords.y, 'delete');
		});
	}

	zoomAt(clientX, clientY, factor) {
		const r = this.canvas.getBoundingClientRect();
		const mx = clientX - r.left;
		const my = clientY - r.top;
		const wx = (mx - this.t.x) / this.t.k;
		const wy = (my - this.t.y) / this.t.k;
		this.t.k = Math.max(0.01, Math.min(20, this.t.k * factor));
		this.t.x = mx - wx * this.t.k;
		this.t.y = my - wy * this.t.k;
		this.draw();
	}

	handlePointerDown(e) {
		this.canvas.setPointerCapture(e.pointerId);
		this.evCache.push(e);
		this.totalDragDist = 0;

		if (this.onPointerDown) this.onPointerDown(e);

		const coords = this.getImgCoords(e.clientX, e.clientY);

		if (this.onDragPt) {
			const idx = this.onDragPt(coords.x, coords.y, 'check');
			if (idx !== -1) {
				this.activePtIdx = idx;
				this.isDragging = true;
				this.lm = { x: e.clientX, y: e.clientY };
				return;
			}
		}

		this.isDragging = true;
		this.lm = { x: e.clientX, y: e.clientY };
		this.activePtIdx = -1;
	}

	handlePointerMove(e) {
		const index = this.evCache.findIndex(cached => cached.pointerId === e.pointerId);
		if (index > -1) this.evCache[index] = e;

		if (this.evCache.length === 2) {
			const dx = this.evCache[0].clientX - this.evCache[1].clientX;
			const dy = this.evCache[0].clientY - this.evCache[1].clientY;
			const curDiff = Math.hypot(dx, dy);

			if (this.prevDiff > 0) {
				const factor = 1 + ((curDiff - this.prevDiff) * 0.01);
				const cx = (this.evCache[0].clientX + this.evCache[1].clientX) / 2;
				const cy = (this.evCache[0].clientY + this.evCache[1].clientY) / 2;
				this.zoomAt(cx, cy, factor);
			}
			this.prevDiff = curDiff;
			this.totalDragDist += 20;
			return;
		}

		if (this.isDragging && this.evCache.length === 1) {
			const dx = e.clientX - this.lm.x;
			const dy = e.clientY - this.lm.y;
			this.totalDragDist += Math.hypot(dx, dy);

			if (this.activePtIdx !== -1) {
				const curr = this.getImgCoords(e.clientX, e.clientY);
				const prev = this.getImgCoords(this.lm.x, this.lm.y);
				this.onDragPt(curr.x - prev.x, curr.y - prev.y, 'move', this.activePtIdx);
			} else {
				this.t.x += dx;
				this.t.y += dy;
				this.draw();
			}
			this.lm = { x: e.clientX, y: e.clientY };
		}

		if(this.onMouseMove) {
			const coords = this.getImgCoords(e.clientX, e.clientY);
			this.onMouseMove(coords.x, coords.y);
		}
	}

	handlePointerUp(e) {
		const index = this.evCache.findIndex(cached => cached.pointerId === e.pointerId);
		if (index > -1) this.evCache.splice(index, 1);
		if (this.evCache.length < 2) this.prevDiff = -1;

		if (this.evCache.length === 0) {
			if (this.totalDragDist < 20) {
				if (this.activePtIdx === -1 && this.onClick) {
					const coords = this.getImgCoords(e.clientX, e.clientY);
					this.onClick(coords.x, coords.y, e);
				}
			}
			this.isDragging = false;
			this.activePtIdx = -1;
		}
	}

	getImgCoords(screenX, screenY) {
		const r = this.canvas.getBoundingClientRect();
		const mx = (screenX - r.left - this.t.x) / this.t.k;
		const my = (screenY - r.top - this.t.y) / this.t.k;
		if (this.isMirrored && this.bmp) { return { x: this.bmp.width - mx, y: my }; }
		return { x: mx, y: my };
	}

	setMirror(val) { this.isMirrored = val; this.draw(); }
	setImage(b) { this.bmp = b; this.draw(); }
	setDimmed(isDimmed) {
		this.canvas.style.filter = isDimmed ? "brightness(0.4) grayscale(100%)" : "none";
	}
	fit() {
		if(!this.bmp || !this.canvas) return;
		const vw = this.canvas.width;
		const vh = this.canvas.height;
		if (vw === 0 || vh === 0) return;
		const iw = this.bmp.width;
		const ih = this.bmp.height;
		const scale = Math.min(vw / iw, vh / ih);
		const cx = (vw - iw * scale) / 2;
		const cy = (vh - ih * scale) / 2;
		this.t = { x: cx, y: cy, k: scale };
		this.draw();
	}
	draw() {
		if(!this.ctx) return;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.t.x, this.t.y);
		this.ctx.scale(this.t.k, this.t.k);
		if (this.bmp) {
			this.ctx.save();
			if (this.isMirrored) {
				this.ctx.translate(this.bmp.width, 0);
				this.ctx.scale(-1, 1);
			}
			this.ctx.drawImage(this.bmp, 0, 0);
			this.ctx.restore();
		}
		if (this.onDraw) this.onDraw(this.ctx, this.t.k);
		this.ctx.restore();
	}
}
