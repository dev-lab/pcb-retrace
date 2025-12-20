/* canvas-ui.js - Shared Canvas Logic */

class PanZoomCanvas {
	constructor(id, onDraw, onClick, onDragPt) {
		this.canvas = document.getElementById(id);
		this.container = this.canvas ? this.canvas.parentElement : null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.bmp = null;
		
		this.t = {x:0, y:0, k:1}; // Changed default k to 1, but fit() will override
		
		this.drag = false;
		this.lm = {x:0, y:0};
		this.activePtIdx = -1;
		this.isMirrored = false;
		
		this.onDraw = onDraw; 
		this.onClick = onClick; 
		this.onDragPt = onDragPt;
		this.onMouseMove = null; 

		if(this.container) {
			new ResizeObserver(() => {
				if(this.container && this.container.clientWidth > 0) {
					this.canvas.width = this.container.clientWidth;
					this.canvas.height = this.container.clientHeight;
					this.draw();
				}
			}).observe(this.container);
			this.initEvents();
		}
	}

	initEvents() {
		this.canvas.onwheel = e => {
			e.preventDefault();
			const f = Math.exp(-e.deltaY * 0.001);
			const r = this.canvas.getBoundingClientRect();
			const mx = e.clientX - r.left, my = e.clientY - r.top;
			const wx = (mx - this.t.x) / this.t.k, wy = (my - this.t.y) / this.t.k;
			this.t.k = Math.max(0.01, Math.min(20, this.t.k * f));
			this.t.x = mx - wx * this.t.k;
			this.t.y = my - wy * this.t.k;
			this.draw();
		};

		this.canvas.onmousedown = e => {
			const coords = this.getImgCoords(e.clientX, e.clientY);
			if (this.onDragPt) {
				const idx = this.onDragPt(coords.x, coords.y, 'check');
				if (idx !== -1) {
					this.activePtIdx = idx;
					this.drag = true;
					this.lm = { x: e.clientX, y: e.clientY };
					return;
				}
			}
			this.drag = true;
			this.lm = { x: e.clientX, y: e.clientY };
			this.activePtIdx = -1;
		};

		this.canvas.oncontextmenu = e => {
			e.preventDefault();
			const coords = this.getImgCoords(e.clientX, e.clientY);
			if (this.onDragPt) this.onDragPt(coords.x, coords.y, 'delete');
		};

		window.addEventListener('mousemove', e => {
			if (this.drag) {
				if (this.activePtIdx !== -1) {
					const r = this.canvas.getBoundingClientRect();
					const curr = this.getImgCoords(e.clientX, e.clientY);
					const prev = this.getImgCoords(this.lm.x, this.lm.y);
					const dx = curr.x - prev.x;
					const dy = curr.y - prev.y;
					this.onDragPt(dx, dy, 'move', this.activePtIdx);
					this.lm = { x: e.clientX, y: e.clientY };
				} else {
					this.t.x += e.clientX - this.lm.x;
					this.t.y += e.clientY - this.lm.y;
					this.lm = { x: e.clientX, y: e.clientY };
					this.draw();
				}
			}
			if(this.onMouseMove && e.target === this.canvas) {
				const coords = this.getImgCoords(e.clientX, e.clientY);
				this.onMouseMove(coords.x, coords.y);
			}
		});

		window.addEventListener('mouseup', e => {
			if (this.drag && this.activePtIdx === -1 && e.shiftKey && this.onClick) {
				const coords = this.getImgCoords(e.clientX, e.clientY);
				this.onClick(coords.x, coords.y);
			}
			this.drag = false;
			this.activePtIdx = -1;
		});
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
		if(isDimmed) this.canvas.style.filter = "brightness(0.4) grayscale(100%)";
		else this.canvas.style.filter = "none";
	}

	// [NEW] Fit Image to Container
	fit() {
		if(!this.bmp || !this.canvas) return;
		const vw = this.canvas.width;
		const vh = this.canvas.height;
		if (vw === 0 || vh === 0) return;
		
		const iw = this.bmp.width;
		const ih = this.bmp.height;
		
		// Scale to fit
		const scale = Math.min(vw / iw, vh / ih);
		
		// Center
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
