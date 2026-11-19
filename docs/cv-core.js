/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

/* cv-core.js - Computer Vision Logic for PCB ReTrace Suite */
class CVManager {
	constructor() {
		this.ready = false;
		this.initAttempts = 0;
		this.detector = null;
		this.matcher = null;
		// Feature cache: image id → { key, f }. Map insertion order doubles as LRU order.
		this.featCache = new Map();
		this.featPending = new Map();	// image id → in-flight extraction promise
		this.maxCached = 60;			// ~300 KB per image → ~20 MB worst case
	}

	async init() {
		if (this.ready) return;
		if (typeof cv !== 'undefined' && cv.Mat) {
			try {
				// Tuned Settings: ORB 5000, Hamming
				// More pyramid levels → tolerates much larger scale differences (macro vs wide)
				this.detector = new cv.ORB(5000, 1.2, 12);
				this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
				this.cfg = {
					ratio: 0.75,		  // Lowe ratio (applied in both directions)
					minMatches: 20,		  // mutual matches needed before even trying RANSAC
					minInliers: 15,		  // inliers after refinement
					minInlierRatio: 0.20, // inliers / mutual matches
					ransacPx: 4,		  // RANSAC threshold, in 2000px-working-image pixels
					refinePx: 3,		  // inlier threshold after least-squares refit
					minCoverage: 0.08,	  // inliers' bbox must cover this fraction of at least one image
					minScale: 0.05,		  // allowed src→dst scale range (macro vs wide)
					maxScale: 20
				};
				this.ready = true;
				console.log("CV Core Initialized");
			} catch (e) {
				console.error("CV Init Error:", e);
			}
		} else {
			this.initAttempts++;
			if (this.initAttempts < 50) setTimeout(() => this.init(), 500);
			else console.error("CV Failed to load OpenCV.js");
		}
	}

	// Helper: Project (x,y) using Homography Matrix
	projectPoint(x, y, h) {
		if (!h || h.length < 9) return null;
		const Z = h[6] * x + h[7] * y + h[8];
		if (Math.abs(Z) < 0.0001) return null;
		return {
			x: (h[0] * x + h[1] * y + h[2]) / Z,
			y: (h[3] * x + h[4] * y + h[5]) / Z
		};
	}

	// Helper: Resize for processing (Speed optimization)
	async createSmallMat(blob) {
		const maxWidth = 2000; // Tuned for optimal accuracy/speed
		const bmp = await createImageBitmap(blob);
		const origW = bmp.width, origH = bmp.height;
		const canvas = document.createElement('canvas');
		const scale = Math.min(1, maxWidth / origW);

		canvas.width = origW * scale;
		canvas.height = origH * scale;

		const ctx = canvas.getContext('2d');
		ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
		bmp.close();

		const mat = cv.imread(canvas);
		const gray = new cv.Mat();
		cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
		mat.delete();

		// Cleanup canvas to free memory
		canvas.width = 0; canvas.height = 0;

		return { mat: gray, scale: scale, width: origW, height: origH };
	}

	// Solve Manual Stitch (Least Squares)
	solveManual(pairs) {
		if (pairs.length < 4) return null;
		const srcMat = new cv.Mat(pairs.length, 1, cv.CV_32FC2);
		const dstMat = new cv.Mat(pairs.length, 1, cv.CV_32FC2);

		for (let i = 0; i < pairs.length; i++) {
			srcMat.data32F[i * 2] = pairs[i].s.x;
			srcMat.data32F[i * 2 + 1] = pairs[i].s.y;
			dstMat.data32F[i * 2] = pairs[i].d.x;
			dstMat.data32F[i * 2 + 1] = pairs[i].d.y;
		}

		// Method 0 = Least Squares (Best for manual precise points)
		const H = cv.findHomography(srcMat, dstMat, 0);

		if (H.empty()) {
			srcMat.delete(); dstMat.delete(); H.delete();
			return null;
		}

		const hd = [];
		const Hi = H.inv(cv.DECOMP_LU);
		const ihd = [];

		for (let i = 0; i < 9; i++) hd.push(H.data64F[i]);
		for (let i = 0; i < 9; i++) ihd.push(Hi.data64F[i]);

		srcMat.delete(); dstMat.delete(); H.delete(); Hi.delete();
		return { hData: hd, invHData: ihd };
	}

	// Extract Features
	async feats(blob) {
		if (!this.ready) return null;
		const { mat, scale, width, height } = await this.createSmallMat(blob);
		const kp = new cv.KeyPointVector();
		const des = new cv.Mat();
		const mask = new cv.Mat();
		this.detector.detectAndCompute(mat, mask, kp, des);
		mask.delete();
		mat.delete();
		return { kp, des, scale, w: width, h: height };
	}

	_freeFeats(f) {
		try { f.kp.delete(); } catch (_) {}
		try { f.des.delete(); } catch (_) {}
	}

	/**
	 * Cached feature extraction. Returned objects are OWNED BY THE CACHE:
	 * callers must NOT call kp.delete() / des.delete() on them.
	 * @param img	{ id, blob } image record
	 * @param keep	ids that must not be evicted while this call inserts (e.g. the source image)
	 */
	async getFeats(img, keep = []) {
		if (!this.ready || !img || !img.blob) return null;
		const key = img.blob.size + ':' + img.blob.type;   // detects replaced blobs

		const hit = this.featCache.get(img.id);
		if (hit && hit.key === key) {
			this.featCache.delete(img.id);				   // touch → most recently used
			this.featCache.set(img.id, hit);
			return hit.f;
		}
		if (hit) { this._freeFeats(hit.f); this.featCache.delete(img.id); }

		// Share one extraction between concurrent callers
		let p = this.featPending.get(img.id);
		if (!p) {
			p = this.feats(img.blob).finally(() => this.featPending.delete(img.id));
			this.featPending.set(img.id, p);
		}
		const f = await p;
		if (!f) return null;

		const existing = this.featCache.get(img.id);
		if (existing && existing.f === f) return f;		   // another caller already stored it

		this.featCache.set(img.id, { key, f });

		// Evict least-recently-used entries, never the ones in use
		const protect = new Set([img.id, ...keep]);
		for (const [id, e] of this.featCache) {
			if (this.featCache.size <= this.maxCached) break;
			if (protect.has(id)) continue;
			this._freeFeats(e.f);
			this.featCache.delete(id);
		}
		return f;
	}

	dropFeats(id) {
		const e = this.featCache.get(id);
		if (e) { this._freeFeats(e.f); this.featCache.delete(id); }
	}

	clearFeats() {
		this.featCache.forEach(e => this._freeFeats(e.f));
		this.featCache.clear();
	}

	// Chain two homographies: H_total = H2 * H1
	multiplyH(H2, H1) {
		// H1 and H2 are flat arrays [0..8] representing 3x3 matrices
		// Standard Matrix Multiplication
		const res = new Array(9);
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) {
				let sum = 0;
				for (let k = 0; k < 3; k++) {
					sum += H2[r*3 + k] * H1[k*3 + c];
				}
				res[r*3 + c] = sum;
			}
		}
		return res;
	}

	// knn + ratio test in one direction → Map(queryIdx → trainIdx)
	_ratioMatches(qDes, tDes) {
		const mv = new cv.DMatchVectorVector();
		this.matcher.knnMatch(qDes, tDes, mv, 2);
		const out = new Map();
		for (let i = 0; i < mv.size(); i++) {
			const row = mv.get(i);
			if (row.size() < 2) continue;
			const m = row.get(0), n = row.get(1);
			if (m.distance < this.cfg.ratio * n.distance) out.set(m.queryIdx, m.trainIdx);
		}
		mv.delete();
		return out;
	}

	// Geometric sanity check of a src→dst homography (flat 9-array)
	_sane(h, sw, sh, dw, dh) {
		const c = this.cfg;
		// Orientation must be preserved (auto-stitch cannot legitimately produce a flip)
		if (h[0] * h[4] - h[1] * h[3] <= 0) return 'reflection';

		const q = [[0, 0], [sw, 0], [sw, sh], [0, sh]].map(([x, y]) => this.projectPoint(x, y, h));
		if (q.some(p => !p || !isFinite(p.x) || !isFinite(p.y))) return 'degenerate corners';

		// Projected image must be a convex quad with consistent winding
		let sign = 0;
		for (let i = 0; i < 4; i++) {
			const a = q[i], b = q[(i + 1) % 4], d = q[(i + 2) % 4];
			const cr = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
			if (cr === 0) return 'collinear';
			if (sign === 0) sign = Math.sign(cr);
			else if (Math.sign(cr) !== sign) return 'non-convex';
		}
		let area = 0;
		for (let i = 0; i < 4; i++) {
			const a = q[i], b = q[(i + 1) % 4];
			area += a.x * b.y - b.x * a.y;
		}
		area = Math.abs(area) / 2;
		const scale = Math.sqrt(area / (sw * sh));
		if (scale < c.minScale || scale > c.maxScale) return `scale ${scale.toFixed(3)}`;
		return null;
	}

		// Find Homography between two feature sets
	findH(s, d) {
		const c = this.cfg;
		if (!s || !d || s.des.rows < 10 || d.des.rows < 10) return null;

		// 1. Mutual ratio-test matches (s→d and d→s must agree)
		const fwd = this._ratioMatches(s.des, d.des);
		const bwd = this._ratioMatches(d.des, s.des);
		const good = [];
		fwd.forEach((t, q) => { if (bwd.get(t) === q) good.push({ q, t }); });
		if (good.length < c.minMatches) return null;

		// 2. Build point sets (original-resolution coordinates)
		const n = good.length;
		const sp = new cv.Mat(n, 1, cv.CV_32FC2);
		const dp = new cv.Mat(n, 1, cv.CV_32FC2);
		for (let i = 0; i < n; i++) {
			const k1 = s.kp.get(good[i].q), k2 = d.kp.get(good[i].t);
			sp.data32F[i * 2] = k1.pt.x / s.scale;	   sp.data32F[i * 2 + 1] = k1.pt.y / s.scale;
			dp.data32F[i * 2] = k2.pt.x / d.scale;	   dp.data32F[i * 2 + 1] = k2.pt.y / d.scale;
		}

		const mats = [sp, dp];
		const cleanup = () => mats.forEach(m => { try { m.delete(); } catch (_) {} });

		// 3. RANSAC — threshold expressed in working-image pixels of the destination
		const mask = new cv.Mat(); mats.push(mask);
		let H = cv.findHomography(sp, dp, cv.RANSAC, c.ransacPx / d.scale, mask);
		mats.push(H);
		if (H.empty()) { cleanup(); return null; }

		const inl = [];
		for (let i = 0; i < n; i++) if (mask.data[i]) inl.push(i);
		if (inl.length < c.minInliers) { cleanup(); return null; }

		// 4. Least-squares refit on inliers, then recount with a tighter threshold
		const sIn = new cv.Mat(inl.length, 1, cv.CV_32FC2); mats.push(sIn);
		const dIn = new cv.Mat(inl.length, 1, cv.CV_32FC2); mats.push(dIn);
		inl.forEach((idx, j) => {
			sIn.data32F[j * 2] = sp.data32F[idx * 2]; sIn.data32F[j * 2 + 1] = sp.data32F[idx * 2 + 1];
			dIn.data32F[j * 2] = dp.data32F[idx * 2]; dIn.data32F[j * 2 + 1] = dp.data32F[idx * 2 + 1];
		});
		const H2 = cv.findHomography(sIn, dIn, 0); mats.push(H2);
		if (!H2.empty()) H = H2;

		const hd = []; for (let i = 0; i < 9; i++) hd.push(H.data64F[i]);

		let final = [], sumSq = 0;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		let dMinX = Infinity, dMinY = Infinity, dMaxX = -Infinity, dMaxY = -Infinity;
		for (let i = 0; i < n; i++) {
			const p = this.projectPoint(sp.data32F[i * 2], sp.data32F[i * 2 + 1], hd);
			if (!p) continue;
			const err = Math.hypot(p.x - dp.data32F[i * 2], p.y - dp.data32F[i * 2 + 1]) * d.scale;
			if (err <= c.refinePx) {
				final.push(i); sumSq += err * err;
				const sx = sp.data32F[i * 2], sy = sp.data32F[i * 2 + 1];
				const tx = dp.data32F[i * 2], ty = dp.data32F[i * 2 + 1];
				minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
				minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
				dMinX = Math.min(dMinX, tx); dMaxX = Math.max(dMaxX, tx);
				dMinY = Math.min(dMinY, ty); dMaxY = Math.max(dMaxY, ty);
			}
		}
		const inliers = final.length;
		const ratio = inliers / n;

		// 5. Acceptance tests
		let reason = null;
		if (inliers < c.minInliers) reason = `inliers ${inliers}`;
		else if (ratio < c.minInlierRatio) reason = `ratio ${ratio.toFixed(2)}`;
		else {
			const covS = ((maxX - minX) * (maxY - minY)) / (s.w * s.h);
			const covD = ((dMaxX - dMinX) * (dMaxY - dMinY)) / (d.w * d.h);
			if (Math.max(covS, covD) < c.minCoverage) reason = `clustered (${covS.toFixed(3)}/${covD.toFixed(3)})`;
			else reason = this._sane(hd, s.w, s.h, d.w, d.h);
		}

		if (reason) {
			console.log(`[CV] rejected: ${reason} (mutual=${n}, inliers=${inliers})`);
			cleanup(); return null;
		}

		const Hi = H.inv(cv.DECOMP_LU); mats.push(Hi);
		const ihd = []; for (let i = 0; i < 9; i++) ihd.push(Hi.data64F[i]);
		console.log(`[CV] accepted: mutual=${n}, inliers=${inliers}, rmse=${Math.sqrt(sumSq / inliers).toFixed(2)}px`);
		cleanup();
		return { hData: hd, invHData: ihd, matches: inliers, mutual: n, rmse: Math.sqrt(sumSq / inliers) };
	}

}
