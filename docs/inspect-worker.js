/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

// inspect-worker — PcbVisualizer routing off the main thread

let WB = null, ready = null;

function init({ jsUrl, wasmUrl }) {
	ready = import(jsUrl)
		.then(m => m.default({ locateFile: f => f === 'WireBender.wasm' ? wasmUrl : f }))
		.then(mod => { WB = mod; });
}

function route(items) {
	const pcb = new WB.PcbVisualizer();
	const byKey = {};
	try {
		items.forEach(({ id, pads }) => {
			const vec = new WB.VectorPoint2D();
			pads.forEach(p => vec.push_back({ x: p.x, y: p.y }));
			pcb.addNet({ name: id, pads: vec });
			vec.delete();
		});
		const result = pcb.route();
		for (let i = 0; i < result.wires.size(); i++) {
			const wire = result.wires.get(i);
			const pts = [];
			for (let j = 0; j < wire.points.size(); j++) {
				const p = wire.points.get(j);
				pts.push({ x: p.x, y: p.y });
			}
			if (pts.length >= 2) (byKey[wire.net] ||= { wires: [], junctions: [] }).wires.push(pts);
		}
		for (let i = 0; i < result.junctions.size(); i++) {
			const d = result.junctions.get(i);
			(byKey[d.net] ||= { wires: [], junctions: [] }).junctions.push({ x: d.position.x, y: d.position.y });
		}
	} finally {
		try { if (pcb.clear) pcb.clear(); } catch (_) {}
		try { if (pcb.delete) pcb.delete(); } catch (_) {}
	}
	return byKey;
}

self.onmessage = async e => {
	const d = e.data;
	if (d.type === 'init') { init(d); return; }
	try {
		await ready;
		self.postMessage({ id: d.id, ok: true, result: route(d.items) });
	} catch (err) {
		self.postMessage({ id: d.id, ok: false, error: String(err && err.message || err) });
	}
};
