/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

// router-worker — runs WireBender off the main thread

const WB_URL = 'https://dev-lab.github.io/WireBender/latest/WireBender.js';
const WB_WASM = 'https://dev-lab.github.io/WireBender/latest/WireBender.wasm';

let WB = null, wb = null;
const ready = import(WB_URL)
	.then(m => m.default({ locateFile: f => f === 'WireBender.wasm' ? WB_WASM : f }))
	.then(mod => { WB = mod; });

function destroy() { if (wb) { try { wb.delete(); } catch (_) {} wb = null; } }

function addComponent(d) {
	const v = new WB.VectorPinDescriptor();
	d.pins.forEach(p => v.push_back({ number: p.number, name: p.name, x: p.x, y: p.y, directionFlags: p.directionFlags }));
	wb.addComponent({ id: d.id, width: d.width, height: d.height, padding: d.padding, pins: v });
	v.delete();
}

// Emscripten result → plain structured-cloneable object
function toPlain(r) {
	const out = { wires: [], junctions: [], componentLabels: null };
	for (let i = 0; i < r.wires.size(); i++) {
		const w = r.wires.get(i), pts = [];
		for (let j = 0; j < w.points.size(); j++) { const p = w.points.get(j); pts.push({ x: p.x, y: p.y }); }
		out.wires.push({ net: w.net, points: pts });
	}
	for (let i = 0; i < r.junctions.size(); i++) {
		const d = r.junctions.get(i);
		out.junctions.push({ net: d.net, position: { x: d.position.x, y: d.position.y } });
	}
	if (r.componentLabels) {
		out.componentLabels = [];
		for (let i = 0; i < r.componentLabels.size(); i++) {
			const h = r.componentLabels.get(i);
			out.componentLabels.push({
				componentId: h.componentId,
				refPosition: { x: h.refPosition.x, y: h.refPosition.y }, refIsVertical: h.refIsVertical,
				valuePosition: { x: h.valuePosition.x, y: h.valuePosition.y }, valueIsVertical: h.valueIsVertical,
			});
		}
	}
	return out;
}

const handlers = {
	// Full (re)build. runPlacement=false → use exact placements supplied by the client.
	build({ model, placements, locks, runPlacement }) {
		destroy();
		wb = new WB.WireBender();
		model.components.forEach(addComponent);
		model.nets.forEach(n => {
			const v = new WB.VectorPinRef();
			n.pins.forEach(p => v.push_back(p));
			wb.addNet({ name: n.name, pins: v });
			v.delete();
		});

		const cls = wb.classify();
		for (let i = 0; i < cls.size(); ++i) {
			const it = cls.get(i);
			if (it.isBus) { it.isBus = false; it.isGround = false; it.isPositive = false; it.busLevel = -1; cls.set(i, it); }
		}
		wb.applyClassification(cls);
		cls.delete();

		let placed = {};
		if (runPlacement) {
			if (locks && Object.keys(locks).length) {
				const l = new WB.ComponentPlacements();
				l.fromObject(locks);
				wb.setLockedPlacements(l);
				l.delete();
			}
			placed = wb.computePlacements().toObject();
		} else {
			for (const id in placements) wb.setComponentPlacement(id, placements[id]);
		}
		return { placements: placed, route: toPlain(wb.routeAll()) };
	},

	// Ordered list of incremental ops against the live router state.
	incremental({ ops }) {
		const results = [];
		for (const op of ops) {
			if (op.op === 'move') {
				const r = wb.moveComponent(op.compId, op.placement);
				const affected = [];
				for (let i = 0; i < r.affectedNets.size(); i++) affected.push(r.affectedNets.get(i));
				results.push({ route: toPlain(r.routes), affected });
			} else if (op.op === 'replace') {
				const v = new WB.VectorPinDescriptor();
				op.desc.pins.forEach(p => v.push_back({ number: p.number, name: p.name, x: p.x, y: p.y, directionFlags: p.directionFlags }));
				const map = new WB.PinMap();
				map.fromObject(op.pinMap);
				const r = wb.replaceComponent({
					componentId: op.compId,
					newDescriptor: { id: op.desc.id, width: op.desc.width, height: op.desc.height, padding: op.desc.padding, pins: v },
					pinMapping: map,
				});
				v.delete(); map.delete();
				results.push({ route: toPlain(r), affected: null });
			}
		}
		return { results };
	},
};

self.onmessage = async e => {
	const { id, type, ...payload } = e.data;
	try {
		await ready;
		self.postMessage({ id, ok: true, result: handlers[type](payload) });
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err && err.message || err) });
	}
};
