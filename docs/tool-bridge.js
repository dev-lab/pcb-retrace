/**
 * tool-bridge.js
 * Common logic for connecting Component Tools (iframe) to the main Application (studio.js).
 * Handles: PostMessage, Spyglass Views, Promotion, and Dragging.
 */
class ToolBridge {
	constructor(config) {
		this.cfg = config;
		this.availableViews = [];
		this.currentViewIdx = 0;
		this.spyglass = null;
		this.pendingViewInit = null; // Buffer for race condition fix

		// Initialize Spyglass
		const initSpyglass = () => {
			const canvas = document.getElementById('tool-canvas');
			if (typeof PcbSpyglass !== 'undefined' && canvas) {
				this.spyglass = new PcbSpyglass('tool-canvas', 'tool-zoom', (x, y) => this.handleDrag(x, y));

				// If we received data before spyglass was ready, apply it now
				if (this.pendingViewInit !== null) {
					this.selectView(this.pendingViewInit);
					this.pendingViewInit = null;
				}
			}
		};

		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', initSpyglass);
		} else {
			// If already loaded, init immediately (microtask)
			setTimeout(initSpyglass, 0);
		}

		window.addEventListener('message', this.handleMessage.bind(this));
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				window.parent.postMessage({ type: 'ESC_PRESSED' }, '*');
			}
		});
	}

	handleMessage(event) {
		if (!event.data || event.data.type !== 'INIT_TOOL') return;
		const d = event.data;

		// 1. Pass Data to Tool
		if (this.cfg.onData) {
			this.cfg.onData({ value: d.value, description: d.description });
		}

		// 2. Handle Views
		if (d.views && d.views.length > 0) {
			this.availableViews = d.views;
			this.renderViewSelector();

			const mainIdx = this.availableViews.findIndex(v => v.isMain);
			const targetIdx = mainIdx !== -1 ? mainIdx : 0;

			this.toggleSpyglass(true);

			// Check if spyglass is ready
			if (this.spyglass) {
				this.selectView(targetIdx);
			} else {
				// Buffer it for later
				this.pendingViewInit = targetIdx;
			}
		} else if (d.bitmap) {
			// Legacy support
			this.availableViews = [{ bitmap: d.bitmap, x: d.x, y: d.y, name: 'Main', isMain: true }];
			this.renderViewSelector();
			this.toggleSpyglass(true);

			if (this.spyglass) this.selectView(0);
			else this.pendingViewInit = 0;
		} else {
			this.toggleSpyglass(false);
		}
	}

	toggleSpyglass(show) {
		const el = document.getElementById('spyglass-col');
		if (el) {
			if (show) el.classList.add('active');
			else {
				el.classList.remove('active');
				if (this.spyglass) this.spyglass.clear();
			}
		}
	}

	renderViewSelector() {
		const container = document.getElementById('view-selector');
		if (!container) return;
		container.innerHTML = '';
		if (this.availableViews.length <= 1) return;

		this.availableViews.forEach((v, idx) => {
			const thumb = document.createElement('div');
			thumb.className = 'view-thumb';
			if (v.isMain) thumb.style.borderColor = 'var(--accent, #2563eb)';

			const cvs = document.createElement('canvas');
			cvs.width = 100; cvs.height = 100;
			const ctx = cvs.getContext('2d');
			try {
				const sSize = 200;
				const sx = Math.max(0, v.x - sSize/2);
				const sy = Math.max(0, v.y - sSize/2);
				ctx.drawImage(v.bitmap, sx, sy, sSize, sSize, 0, 0, 100, 100);
			} catch(e) {}

			thumb.innerHTML = `<span>${v.name}</span>`;
			thumb.appendChild(cvs);

			if (!v.isMain) {
				const btn = document.createElement('button');
				btn.className = 'promote-btn';
				btn.innerText = '★';
				btn.onclick = (e) => { e.stopPropagation(); this.promoteView(idx); };
				thumb.appendChild(btn);
			}

			thumb.onclick = () => {
				const all = container.querySelectorAll('.view-thumb');
				all.forEach(t => t.style.borderColor = '#ccc');
				thumb.style.borderColor = 'var(--accent, #2563eb)';
				this.selectView(idx);
			};
			container.appendChild(thumb);
		});
	}

	selectView(idx) {
		this.currentViewIdx = idx;
		const v = this.availableViews[idx];
		if (this.spyglass && v && v.bitmap) {
			this.spyglass.setTarget(v.bitmap, v.x, v.y, false);
		}
	}

	promoteView(idx) {
		const v = this.availableViews[idx];
		window.parent.postMessage({ type: 'PROMOTE_VIEW', x: v.x, y: v.y, imgId: v.imgId }, '*');
	}

	handleDrag(x, y) {
		if (this.availableViews[this.currentViewIdx]) {
			this.availableViews[this.currentViewIdx].x = x;
			this.availableViews[this.currentViewIdx].y = y;
		}
		if (this.availableViews[this.currentViewIdx].isMain) {
			window.parent.postMessage({ type: 'UPDATE_POS', x: x, y: y }, '*');
		}
	}

	sendResult(valueOverride = null, descOverride = null) {
		const val = valueOverride || (this.cfg.onNominal ? this.cfg.onNominal() : null);
		const desc = descOverride || (this.cfg.onDescription ? this.cfg.onDescription() : "");
		if (val) window.parent.postMessage({ type: 'COMPONENT_UPDATE', value: val, description: desc }, '*');
	}
}
