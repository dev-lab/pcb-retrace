/* stitch-editor.js */

// PanZoomCanvas class removed (moved to canvas-ui.js)

class StitchEditor {
	constructor(dbInstance, cvInstance) {
        // ... (Constructor remains the same) ...
        // It will now use the global PanZoomCanvas class
		this.db = dbInstance;
		this.cv = cvInstance;
		this.modal = document.getElementById('stitch-modal');
		this.srcId = null; this.dstId = null;
		this.points = [];
		this.colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#ff8800', '#88ff00'];

		this.viewSrc = new PanZoomCanvas('stitch-canvas-src',
			(c, k) => this.drawPts(c, k, 's'),
			(x, y) => this.addPt(x, y, 's'),
			(x, y, m, i) => this.hit(x, y, m, i, 's')
		);
		this.viewDst = new PanZoomCanvas('stitch-canvas-dst',
			(c, k) => this.drawPts(c, k, 'd'),
			(x, y) => this.addPt(x, y, 'd'),
			(x, y, m, i) => this.hit(x, y, m, i, 'd')
		);
		this.injectFlipControls();
	}
    
    injectFlipControls() {
		const toolbar = document.querySelector('.stitch-toolbar');
		if(toolbar && !document.getElementById('btn-stitch-flip')) {
			const container = document.createElement('div');
			container.style.display = 'flex';
			container.style.gap = '5px';
			container.style.marginRight = 'auto'; 
			const btnFlip = document.createElement('button');
			btnFlip.id = 'btn-stitch-flip';
			btnFlip.className = 'secondary';
			btnFlip.innerText = '↔ Flip Target';
			btnFlip.onclick = () => this.toggleFlip(btnFlip);
			container.appendChild(btnFlip);
			if(toolbar.firstChild) toolbar.insertBefore(container, toolbar.firstChild);
			else toolbar.appendChild(container);
		}
	}
	
	toggleFlip(btn) {
		const newVal = !this.viewDst.isMirrored;
		this.viewDst.setMirror(newVal);
		btn.style.background = newVal ? '#e0f2fe' : '';
		btn.style.borderColor = newVal ? '#2563eb' : '';
		this.refresh();
	}

	getGridCoords(w, h, n) {
		const coords = [];
		const factors = (n === 2) ? [0.25, 0.75] : [0.15, 0.5, 0.85];
		for(let fy of factors) {
			for(let fx of factors) {
				coords.push({ x: w * fx, y: h * fy });
			}
		}
		return coords;
	}

	getOverlapRect(wSrc, hSrc, wDst, hDst, H) {
		const corners = [
			{x:0, y:0}, {x:wSrc, y:0}, {x:wSrc, y:hSrc}, {x:0, y:hSrc}
		].map(p => this.cv.projectPoint(p.x, p.y, H)).filter(p => p !== null);

		if(corners.length < 4) return null;

		const minPx = Math.min(...corners.map(p => p.x));
		const maxPx = Math.max(...corners.map(p => p.x));
		const minPy = Math.min(...corners.map(p => p.y));
		const maxPy = Math.max(...corners.map(p => p.y));

		const iMinX = Math.max(0, minPx);
		const iMaxX = Math.min(wDst, maxPx);
		const iMinY = Math.max(0, minPy);
		const iMaxY = Math.min(hDst, maxPy);

		if (iMinX >= iMaxX || iMinY >= iMaxY) return null;
		return { x: iMinX, y: iMinY, w: iMaxX - iMinX, h: iMaxY - iMinY };
	}

	setGrid(n, explicitH = null, explicitInvH = null) {
		if(!this.viewSrc.bmp || !this.viewDst.bmp) return;
		let H = explicitH;
		let invH = explicitInvH;
		if (!H && this.points.length >= 4) {
			const res = this.cv.solveManual(this.points);
			if(res) { H = res.hData; invH = res.invHData; }
		}
		this.points = [];
		if (H && invH) {
			const rect = this.getOverlapRect(
				this.viewSrc.bmp.width, this.viewSrc.bmp.height,
				this.viewDst.bmp.width, this.viewDst.bmp.height, 
				H
			);
			if (rect) {
				const dstGrid = this.getGridCoords(rect.w, rect.h, n).map(p => ({
					x: rect.x + p.x,
					y: rect.y + p.y
				}));
				dstGrid.forEach((dPt, i) => {
					const sPt = this.cv.projectPoint(dPt.x, dPt.y, invH);
					if (sPt && sPt.x >= 0 && sPt.y >= 0 && sPt.x <= this.viewSrc.bmp.width && sPt.y <= this.viewSrc.bmp.height) {
						this.points.push({ s: sPt, d: dPt, color: this.colors[i % this.colors.length] });
					}
				});
				if (this.points.length > 0) {
					this.refresh();
					return;
				}
			}
		}
		const sGrid = this.getGridCoords(this.viewSrc.bmp.width, this.viewSrc.bmp.height, n);
		const dGrid = this.getGridCoords(this.viewDst.bmp.width, this.viewDst.bmp.height, n);
		for(let i=0; i<sGrid.length; i++) {
			this.points.push({ s: sGrid[i], d: dGrid[i], color: this.colors[i % this.colors.length] });
		}
		this.refresh();
	}

	clearPoints() {
		this.points = [];
		this.refresh();
	}

	isReflection(H) {
		if (!H || H.length < 5) return false;
		const det = (H[0] * H[4]) - (H[1] * H[3]);
		return det < 0;
	}

	async open(srcImgId, dstImgId) {
		this.srcId = srcImgId;
		this.dstId = dstImgId;

		const i1 = await this.db.getImage(srcImgId);
		const i2 = await this.db.getImage(dstImgId);
		if(!i1 || !i2) return alert("Images not found");

		document.getElementById('stitch-title').innerText = `Stitch: ${i1.name} ↔ ${i2.name}`;

		const bS = await createImageBitmap(i1.blob);
		const bD = await createImageBitmap(i2.blob);

		this.viewSrc.setImage(bS);
		this.viewDst.setImage(bD);

		this.points = [];
		const existing = await this.db.getOverlapsForPair(srcImgId, dstImgId);
		
		let shouldFlip = false;

		if (existing) {
			if (existing.isManual && existing.manualPoints) {
				existing.manualPoints.forEach((p, i) => {
					let ptS, ptD;
					if(existing.fromImageId === this.srcId) { ptS=p.s; ptD=p.d; }
					else { ptS=p.d; ptD=p.s; }
					this.points.push({ s: {x:ptS.x, y:ptS.y}, d: {x:ptD.x, y:ptD.y}, color: this.colors[i % this.colors.length] });
				});
				if (this.points.length >= 3) {
					const tempRes = this.cv.solveManual(this.points);
					if (tempRes && this.isReflection(tempRes.hData)) {
						shouldFlip = true;
					}
				}
			} else if (!existing.isManual && existing.homography) {
				let hToUse = existing.homography;
				let invHToUse = existing.inverseHomography;
				if (existing.fromImageId !== this.srcId) {
					hToUse = existing.inverseHomography;
					invHToUse = existing.homography;
				}
				if (this.isReflection(hToUse)) {
					shouldFlip = true;
				}
				this.setGrid(3, hToUse, invHToUse);
			}
		} else {
			this.setGrid(3);
		}

		this.viewDst.setMirror(shouldFlip);
		const flipBtn = document.getElementById('btn-stitch-flip');
		if(flipBtn) {
			flipBtn.style.background = shouldFlip ? '#e0f2fe' : '';
			flipBtn.style.borderColor = shouldFlip ? '#2563eb' : '';
		}

		this.refresh();
		this.modal.style.display = 'flex';
	}

	refresh() { this.viewSrc.draw(); this.viewDst.draw(); }

	drawPts(ctx, k, side) {
		const ik = 1/k;
		const isMirrored = (side === 'd' && this.viewDst.isMirrored);
		const width = (side === 'd' && this.viewDst.bmp) ? this.viewDst.bmp.width : 0;

		this.points.forEach((p, idx) => {
			const pt = (side==='s') ? p.s : p.d;
			const label = (idx + 1).toString();
			let drawX = pt.x;
			if (isMirrored) drawX = width - pt.x;

			const r=10*ik, len=20*ik, gap=2*ik;
			const path = (c) => {
				c.beginPath(); c.arc(drawX, pt.y, r, 0, Math.PI*2);
				c.moveTo(drawX-len, pt.y); c.lineTo(drawX-gap, pt.y);
				c.moveTo(drawX+gap, pt.y); c.lineTo(drawX+len, pt.y);
				c.moveTo(drawX, pt.y-len); c.lineTo(drawX, pt.y-gap);
				c.moveTo(drawX, pt.y+gap); c.lineTo(drawX, pt.y+len);
			};

			ctx.strokeStyle='black'; ctx.lineWidth=3*ik; path(ctx); ctx.stroke();
			ctx.strokeStyle=p.color; ctx.lineWidth=1.5*ik; path(ctx); ctx.stroke();

			ctx.font = `bold ${14*ik}px sans-serif`;
			ctx.lineWidth = 3*ik; ctx.strokeStyle='black'; ctx.strokeText(label, drawX+8*ik, pt.y-8*ik);
			ctx.fillStyle = 'white'; ctx.fillText(label, drawX+8*ik, pt.y-8*ik);
		});
	}

	addPt(x, y, side) {
		const p = { s:{x:0,y:0}, d:{x:0,y:0}, color: this.colors[this.points.length % this.colors.length] };
		if(side==='s') { p.s={x,y}; p.d={x:this.viewDst.bmp.width/2, y:this.viewDst.bmp.height/2}; }
		else { p.d={x,y}; p.s={x:this.viewSrc.bmp.width/2, y:this.viewSrc.bmp.height/2}; }
		this.points.push(p);
		this.refresh();
	}

	hit(x, y, mode, idx, side) {
		if(mode==='check') {
			 for(let i=this.points.length-1; i>=0; i--) {
				 const pt = (side==='s')?this.points[i].s:this.points[i].d;
				 if(Math.hypot(x-pt.x, y-pt.y) < 20) return i;
			 }
			 return -1;
		} else if(mode==='move') {
			const pt = (side==='s')?this.points[idx].s:this.points[idx].d;
			pt.x+=x; pt.y+=y; this.refresh();
		} else if(mode==='delete') {
			const i=this.hit(x,y,'check',-1,side);
			if(i!==-1) { this.points.splice(i,1); this.refresh(); }
		}
	}

	async save() {
		if(this.points.length < 4) return alert("Need at least 4 points to solve.");
		const res = this.cv.solveManual(this.points);
		if(!res) return alert("Solve failed. Points might be collinear or overlapping.");

		await this.db.deleteOverlapsForPair(this.srcId, this.dstId);

		await this.db.addOverlap({
			id: uuid(),
			fromImageId: this.srcId,
			toImageId: this.dstId,
			homography: res.hData,
			inverseHomography: res.invHData,
			matchCount: this.points.length,
			isManual: true,
			manualPoints: this.points.map(p => ({s:p.s, d:p.d}))
		});

		if(typeof renderList === 'function') renderList();
		if(typeof renderConnectionsList === 'function') renderConnectionsList();
		window.history.back();
	}
}

