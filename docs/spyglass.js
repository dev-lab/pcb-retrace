/**
 * spyglass.js
 * Handles zooming, panning, and coordinate adjustment for PCB previews.
 * v2.1 - Added Pointer Events for Mobile Support (Pinch & Touch-Drag)
 */
class PcbSpyglass {
	/**
	 * @param {string} canvasId
	 * @param {string} overlayId
	 * @param {function} onUpdateCallback - Optional. Called with (x, y) when user drags.
	 */
	constructor(canvasId, overlayId, onUpdateCallback = null) {
		this.canvas = document.getElementById(canvasId);
		this.overlay = document.getElementById(overlayId);
		this.container = this.canvas ? this.canvas.parentElement : null;
		this.onUpdate = onUpdateCallback;

		if (!this.canvas) {
			console.error("Spyglass: Canvas element not found");
			return;
		}

		this.ctx = this.canvas.getContext('2d');
		this.zoom = 2;
		this.img = null;
		this.x = 0;
		this.y = 0;
		this.enabled = false;

		// Pointer State
		this.isDragging = false;
		this.lastMouseX = 0;
		this.lastMouseY = 0;
		this.evCache = []; // Cache for multi-touch
		this.prevDiff = -1; // For pinch zoom

		// Bind Events
		this.canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });

		// Unified Pointer Events (Mouse + Touch)
		this.canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
		this.canvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
		this.canvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
		this.canvas.addEventListener('pointercancel', this.handlePointerUp.bind(this));
		this.canvas.addEventListener('pointerout', this.handlePointerUp.bind(this));
		this.canvas.addEventListener('pointerleave', this.handlePointerUp.bind(this));
	}

	/**
	 * Sets the image and coordinates.
	 * @param {ImageBitmap|HTMLImageElement} imgSource
	 * @param {number} x
	 * @param {number} y
	 * @param {boolean} autoCloseOld - If true, .close() is called on the old bitmap (Use false for galleries)
	 */
	setTarget(imgSource, x, y, autoCloseOld = true) {
		if (!imgSource) return;

		// MEMORY CLEANUP: Only if requested
		if (autoCloseOld && this.img && this.img !== imgSource && typeof this.img.close === 'function') {
			try { this.img.close(); } catch(e) {}
		}

		this.img = imgSource;
		this.x = x;
		this.y = y;
		this.enabled = true;

		if (this.container) {
			this.container.classList.remove('empty');
			this.container.classList.add('active');
		}

		this.render();
		this.updateOverlay();
	}

	clear() {
		this.enabled = false;
		this.img = null;

		if (this.container) {
			this.container.classList.remove('active');
			this.container.classList.add('empty');
		}

		this.ctx.fillStyle = '#ffffff';
		this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

		if (this.overlay) this.overlay.style.display = 'none';
	}

	handleWheel(e) {
		e.preventDefault();
		e.stopPropagation();
		const d = e.deltaY > 0 ? -0.5 : 0.5;
		this.zoom = Math.max(0.5, Math.min(10, this.zoom + d));
		this.render();
		this.updateOverlay();
	}

	// --- POINTER HANDLING (Desktop + Mobile) ---

	handlePointerDown(e) {
		if (!this.enabled) return;
		this.canvas.setPointerCapture(e.pointerId);
		this.evCache.push(e);

		if (this.evCache.length === 1) {
			this.isDragging = true;
			this.lastMouseX = e.clientX;
			this.lastMouseY = e.clientY;
			this.canvas.style.cursor = 'grabbing';
		}
	}

handlePointerMove(e) {
		if (!this.enabled) return;

		// Update cache
		const index = this.evCache.findIndex(cached => cached.pointerId === e.pointerId);
		if (index > -1) this.evCache[index] = e;

		// 1. PINCH ZOOM (2 Fingers)
		if (this.evCache.length === 2) {
			e.preventDefault();
			const dx = this.evCache[0].clientX - this.evCache[1].clientX;
			const dy = this.evCache[0].clientY - this.evCache[1].clientY;
			const curDiff = Math.hypot(dx, dy);

			if (this.prevDiff > 0) {
				const diff = curDiff - this.prevDiff;
				// PATCH 1: Increased Zoom Speed (0.01 -> 0.1)
				this.zoom = Math.max(0.5, Math.min(10, this.zoom + (diff * 0.1)));
				this.render();
				this.updateOverlay();
			}
			this.prevDiff = curDiff;
			return;
		}

		// 2. PANNING (1 Finger / Mouse)
		if (this.isDragging && this.evCache.length === 1) {
			e.preventDefault();
			const dx = e.clientX - this.lastMouseX;
			const dy = e.clientY - this.lastMouseY;

			this.lastMouseX = e.clientX;
			this.lastMouseY = e.clientY;

			// PATCH 2: Speed Multiplier for Touch
			// Mouse stays 1:1 for precision, Touch gets 5x speed to traverse faster
			const speed = (e.pointerType === 'touch') ? 5 : 1.0;

			this.x -= (dx * speed) / this.zoom;
			this.y -= (dy * speed) / this.zoom;

			this.render();

			if (this.onUpdate) {
				this.onUpdate(Math.round(this.x), Math.round(this.y));
			}
		}
	}

	handlePointerUp(e) {
		const index = this.evCache.findIndex(cached => cached.pointerId === e.pointerId);
		if (index > -1) this.evCache.splice(index, 1);

		if (this.evCache.length < 2) this.prevDiff = -1;

		if (this.evCache.length === 0) {
			this.isDragging = false;
			if(this.canvas) this.canvas.style.cursor = 'crosshair';
		} else if (this.evCache.length === 1) {
			// Reset reference point when switching from pinch to pan
			this.lastMouseX = this.evCache[0].clientX;
			this.lastMouseY = this.evCache[0].clientY;
		}
	}

	updateOverlay() {
		if (this.overlay) {
			this.overlay.innerText = this.zoom.toFixed(1) + 'x';
			this.overlay.style.display = this.enabled ? 'block' : 'none';
		}
	}

	render() {
		if (!this.enabled || !this.img) return;

		const w = this.canvas.width;
		const h = this.canvas.height;

		const srcW = w / this.zoom;
		const srcH = h / this.zoom;

		this.ctx.fillStyle = '#ffffff';
		this.ctx.fillRect(0, 0, w, h);

		try {
			this.ctx.drawImage(
				this.img,
				this.x - srcW / 2,
				this.y - srcH / 2,
				srcW, srcH,
				0, 0, w, h
			);

			// Crosshair (Red)
			const cx = Math.floor(w / 2) + 0.5;
			const cy = Math.floor(h / 2) + 0.5;

			this.ctx.strokeStyle = '#ff0000';
			this.ctx.lineWidth = 2;
			this.ctx.lineCap = 'butt';

			this.ctx.beginPath();
			this.ctx.moveTo(0, cy); this.ctx.lineTo(w, cy);
			this.ctx.moveTo(cx, 0); this.ctx.lineTo(cx, h);
			this.ctx.stroke();

		} catch (e) {
			if (e.name !== 'InvalidStateError' && e.name !== 'DOMException') {
				console.error("Spyglass Render Error:", e);
			}
		}
	}
}
