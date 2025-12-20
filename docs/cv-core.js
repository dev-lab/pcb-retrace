/* cv-core.js - Computer Vision Logic for PCB ReTrace Suite */
class CVManager {
	constructor() {
		this.ready = false;
		this.initAttempts = 0;
		this.detector = null;
		this.matcher = null;
	}

	async init() {
		if (this.ready) return;
		if (typeof cv !== 'undefined' && cv.Mat) {
			try {
				// Tuned Settings: ORB 5000, Hamming
				this.detector = new cv.ORB(5000);
				this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
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
		const canvas = document.createElement('canvas');
		const scale = Math.min(1, maxWidth / bmp.width);

		canvas.width = bmp.width * scale;
		canvas.height = bmp.height * scale;

		const ctx = canvas.getContext('2d');
		ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

		const mat = cv.imread(canvas);
		const gray = new cv.Mat();
		cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
		mat.delete();

		// Cleanup canvas to free memory
		canvas.width = 0; canvas.height = 0;

		return { mat: gray, scale: scale, width: bmp.width, height: bmp.height };
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
		this.detector.detectAndCompute(mat, new cv.Mat(), kp, des);
		mat.delete();
		return { kp, des, scale, w: width, h: height };
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

	// Find Homography between two feature sets
	findH(s, d) {
		if (s.des.rows === 0 || d.des.rows === 0) return null;

		const mv = new cv.DMatchVectorVector();
		this.matcher.knnMatch(s.des, d.des, mv, 2);

		const good = [];
		for (let i = 0; i < mv.size(); i++) {
			const m = mv.get(i).get(0), n = mv.get(i).get(1);
			if (m.distance < 0.70 * n.distance) good.push(m); // Ratio Test 0.70
		}
		mv.delete();

		if (good.length > 8) {
			const sp = new cv.Mat(good.length, 1, cv.CV_32FC2);
			const dp = new cv.Mat(good.length, 1, cv.CV_32FC2);

			for (let i = 0; i < good.length; i++) {
				const k1 = s.kp.get(good[i].queryIdx);
				const k2 = d.kp.get(good[i].trainIdx);
				sp.data32F[i * 2] = k1.pt.x / s.scale;
				sp.data32F[i * 2 + 1] = k1.pt.y / s.scale;
				dp.data32F[i * 2] = k2.pt.x / d.scale;
				dp.data32F[i * 2 + 1] = k2.pt.y / d.scale;
			}

			const mask = new cv.Mat();
			// RANSAC 8.0 (Tuned for 2000px resolution)
			const H = cv.findHomography(sp, dp, cv.RANSAC, 8.0, mask);

			if (H.empty()) {
				sp.delete(); dp.delete(); mask.delete(); H.delete();
				return null;
			}

			const hd = [];
			const Hi = H.inv(cv.DECOMP_LU);
			const ihd = [];

			for (let i = 0; i < 9; i++) hd.push(H.data64F[i]);
			for (let i = 0; i < 9; i++) ihd.push(Hi.data64F[i]);

			sp.delete(); dp.delete(); mask.delete(); H.delete(); Hi.delete();
			return { hData: hd, invHData: ihd, matches: good.length };
		}
		return null;
	}
}
