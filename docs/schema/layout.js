// ═══════════════════════════════════════════════════════════════
//	LAYOUT — WireBender placement + routing
//
//	Replaces the previous ELK-based layout.js entirely.
//
//	Workflow (mirrors the prototype in wirebender-test.html):
//		1. Load WASM module once at startup (initWireBender)
//		2. On netlist load / auto-layout:
//				 buildAndRoute()	→ clears wb, re-adds everything,
//														classify → computePlacement → routeAll
//		3. On component drag drop:
//				 routeWires()			→ setComponentPlacement → routeAll
//				 (visual-only drag happens in interaction.js; no routing
//					during the drag, only on drop)
//
//	Persistent instance pattern (from prototype):
//		A single WireBender instance (_wb) is created once and kept
//		alive for the session.	It is destroyed + recreated only when
//		buildAndRoute() is called (full re-layout).	 This is required
//		because setComponentPlacement / routeAll operate on libavoid's
//		live router state.
// ═══════════════════════════════════════════════════════════════

import { S } from './state.js';
import { createComp } from './components.js';
import { render } from './draw.js';

// ── Module loading ────────────────────────────────────────────
let _WB = null;	 // WireBender WASM module (Module object)
let _wb = null;	 // persistent WireBender instance

let _modulePromise = null;

/**
 * Loads the WASM module once.	Subsequent calls return the same promise.
 * Must be called (and awaited) before any routing.
 *
 * Expects WireBender.js and WireBender.wasm to be at the same URL path
 * as the HTML page (i.e. served from the project root alongside index.html).
 * @returns Promise
 */
export function initWireBender() {
	if (_modulePromise) return _modulePromise;
	_modulePromise = import('https://dev-lab.github.io/WireBender/latest/WireBender.js')
		.then(m => m.default({
			locateFile: f => f === 'WireBender.wasm' ? 'https://dev-lab.github.io/WireBender/latest/WireBender.wasm' : f,
		}))
		.then(module => {
			_WB = module;
			console.log('[WireBender] WASM module loaded');
		})
		.catch(err => {
			console.error('[WireBender] Failed to load WASM module:', err);
			// Surface to UI via lazy import to avoid circular dep
			import('./ui.js').then(({ toast }) =>
				toast('WireBender WASM failed to load — check console', 'err'));
		});
	return _modulePromise;
}

/**
 * Destroy persistent WireBender instance.
 */
function _destroyInstance() {
	if (_wb) {
		try { _wb.delete(); } catch (_) { /* ignore */ }
		_wb = null;
	}
}

/**
 * Build WireBender netlist from S
 * Feeds S.components and S.nets into a freshly-created WireBender
 * instance.
 *
 * Call after _wb is (re)created.
 */
function _populateWb() {
	// Step 1: add components
	S.components.forEach(comp => {
		const desc = createComp(comp).wbDescriptor();
		const pinsVec = new _WB.VectorPinDescriptor();
		desc.pins.forEach(p => pinsVec.push_back({
			number: p.number,
			name: p.name,
			x: p.x,
			y: p.y,
			directionFlags: p.directionFlags,
		}));
		_wb.addComponent({
			id: desc.id,
			width: desc.width,
			height: desc.height,
			padding: desc.padding,
			pins: pinsVec,
		});
		pinsVec.delete();
	});

	// Step 2: add nets (only those with ≥ 2 nodes)
	S.nets.forEach(net => {
		const nodes = (net.nodes || []).filter(nd =>
			S.components.find(c => c.ref === nd.ref)
		);
		if (nodes.length < 2) return;

		const pinsVec = new _WB.VectorPinRef();
		nodes.forEach(nd => {
			const comp = S.components.find(c => c.ref === nd.ref);
			if (!comp) return;
			// Find pin index (0-based) → WireBender pin number (1-based)
			const pinIdx = comp.pins.findIndex(
				p => p.originalName === nd.pin || p.originalName === String(nd.pin) ||
					p.name === nd.pin || p.name === String(nd.pin)
			);
			pinsVec.push_back({
				componentId: comp.id,
				pinNumber: pinIdx >= 0 ? pinIdx + 1 : 1,
			});
		});
		_wb.addNet({ name: net.name, pins: pinsVec });
		pinsVec.delete();
	});
}

/**
 * Apply a SchematicRouteResult into S.wires / S.junctionPoints.
 *
 * Converts Emscripten vectors to plain JS arrays.
 * @param result routing result (wires, junctions)
 * @param affectedNets: if given, replaces only those nets; otherwise full rebuild.
 */
function _applyRouteResult(result, affectedNets = null) {
	// Build map: netName → {wires:[[pts]], junctions:[{x,y}]}
	const byNet = {};

	for (let i = 0; i < result.wires.size(); i++) {
		const wire = result.wires.get(i);
		const net = wire.net;
		if (!byNet[net]) byNet[net] = { wires: [], junctions: [] };
		const pts = [];
		for (let j = 0; j < wire.points.size(); j++) {
			const p = wire.points.get(j);
			pts.push({ x: p.x, y: p.y });
		}
		if (pts.length >= 2) byNet[net].wires.push(pts);
	}

	for (let i = 0; i < result.junctions.size(); i++) {
		const jd = result.junctions.get(i);
		const net = jd.net;
		if (!byNet[net]) byNet[net] = { wires: [], junctions: [] };
		byNet[net].junctions.push({ x: jd.position.x, y: jd.position.y });
	}

	// Helper: write wire data for one net into S
	const applyNet = netName => {
		const nd = byNet[netName];
		if (!nd) return;

		// Remove existing wires for this net
		S.wires = S.wires.filter(w => w.net !== netName);
		// Remove existing junctions for this net
		S.junctionPoints = (S.junctionPoints || []).filter(jp => jp.net !== netName);

		let wireSeq = 0;
		nd.wires.forEach(pts => {
			S.wires.push({
				id: `wb_${netName}_${wireSeq++}`,
				net: netName,
				points: pts,
				pinA: null,		// WireBender owns routing — we don't track pin refs per wire
				pinB: null,
			});
		});

		nd.junctions.forEach(j => {
			S.junctionPoints.push({ x: j.x, y: j.y, net: netName });
		});
	};

	if (affectedNets) {
		// Incremental update
		affectedNets.forEach(applyNet);
	} else {
		// Full rebuild
		S.wires = [];
		S.junctionPoints = [];
		Object.keys(byNet).forEach(applyNet);
	}

	// Generate WIP stubs for single-node nets
	_applyWipStubs();

	// Extract component label hints if the WASM module provided them
	S.componentLabels = {};
	if (result.componentLabels) {
		for (let i = 0; i < result.componentLabels.size(); i++) {
			const hint = result.componentLabels.get(i);
			S.componentLabels[hint.componentId] = {
				refPosition: { x: hint.refPosition.x, y: hint.refPosition.y },
				refIsVertical: hint.refIsVertical,
				valuePosition: { x: hint.valuePosition.x, y: hint.valuePosition.y },
				valueIsVertical: hint.valueIsVertical
			};
		}
	}

	// Generate WIP stubs for single-node nets
	_applyWipStubs();
}

/**
 * WIP stubs (single-node nets).
 *
 * For nets with only one connected pin, draw a short dangling stub
 * so the connection is visible. WireBender only routes nets with
 * ≥ 2 nodes; stubs are synthesised here.
 */
function _applyWipStubs() {
	S.nets.forEach(net => {
		if ((net.nodes || []).length !== 1) return;
		const nd = net.nodes[0];
		const comp = S.components.find(c => c.ref === nd.ref);
		if (!comp) return;
		const pins = createComp(comp).pinPositions();
		const pinIdx = comp.pins.findIndex(
			p => p.originalName === nd.pin || p.originalName === String(nd.pin) ||
				p.name === nd.pin || p.name === String(nd.pin)
		);
		const p = pins[pinIdx >= 0 ? pinIdx : 0];
		if (!p) return;
		// Remove any previous stub for this net
		S.wires = S.wires.filter(w => w.id !== `wip_${net.name}`);
		S.wires.push({
			id: `wip_${net.name}`,
			net: net.name,
			points: [
				{ x: p.x, y: p.y },
				{ x: p.x + p.ex * 32, y: p.y + p.ey * 32 },
			],
			pinA: { compId: comp.id, pinName: p.pinName },
			pinB: null,
		});
	});
}

/**
 * Write component placements from WireBender into S.
 * @param placements component placements
 */
function _applyPlacements(placements) {
	for (const id in placements) {
		const placement = placements[id];
		const comp = S.components.find(c => c.id === id);
		if (!comp) continue;
		comp.x = placement.position.x;
		comp.y = placement.position.y;
		comp.rotation = placement.transform.rotation;
		comp.flipX = placement.transform.flipX;
	}
}

/**
 * Fit viewport.
 *
 * Always calls render() so every caller - buttons, keyboard, post-route -
 * doesn't have to remember to chain it.
 */
export function fitView() {
	if (!S.components.length) return;
	let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
	S.components.forEach(c => {
		const g = createComp(c).whTransformed();
		x1 = Math.min(x1, c.x - g.w / 2 - 60); y1 = Math.min(y1, c.y - g.h / 2 - 60);
		x2 = Math.max(x2, c.x + g.w / 2 + 60); y2 = Math.max(y2, c.y + g.h / 2 + 60);
	});
	const cv = document.getElementById('sch-canvas');
	S.zoom = Math.max(0.1, Math.min(0.95, Math.min(cv.width / (x2 - x1), cv.height / (y2 - y1))));
	S.viewX = -((x1 + x2) / 2) * S.zoom;
	S.viewY = -((y1 + y2) / 2) * S.zoom;
	render();
}

/**
 * Full build + layout.
 *
 * Destroys the old WireBender instance, rebuilds the full netlist.
 * If runPlacement is true, runs classify → computePlacement (respecting locks) → routeAll.
 * If false, bypasses placement entirely and uses exact coordinates from S.components.
 *
 * lockedPlacements: optional map { [compId]: {{x, y}, {rotation, flipX}} } of components
 * that should not be moved during auto-placement (e.g. previously
 * user-positioned components loaded from schemaComponents in DB).
 * Coordinates are world-space centre, same as S.components.x/y.
 *
 * Returns the placement result map { [compId]: {{x, y}, {rotation, flipX}} } so the
 * caller can persist newly-placed components to the DB.
 */
export async function buildAndRoute(lockedPlacements = {}, runPlacement = true) {
	if (!S.components.length) {
		render(); // Force clear canvas and show empty state
		return {};
	}
	await initWireBender();
	if (!_WB) return {};

	_destroyInstance();
	_wb = new _WB.WireBender();

	_populateWb();

	// Classify (bus detection)
	const cls = _wb.classify();
	_wb.applyClassification(cls);
	cls.delete();

	let placements = {};

	if (runPlacement) {
		// Apply locked positions before placement
		if (Object.keys(lockedPlacements).length > 0) {
			const locks = new _WB.ComponentPlacements();
			locks.fromObject(lockedPlacements);
			_wb.setLockedPlacements(locks);
			locks.delete();
		}

		placements = _wb.computePlacements().toObject();
		_applyPlacements(placements);
	} else {
		// No placement requested: push exact saved placements directly into WB
		S.components.forEach(comp => {
			_wb.setComponentPlacement(comp.id, { position: { x: comp.x, y: comp.y }, transform: { rotation: comp.rotation || 0, flipX: comp.flipX || false } });
		});
	}

	// Route
	const result = _wb.routeAll();
	_applyRouteResult(result);

	if (runPlacement) fitView();
	else render();

	return placements;
}

/**
 * Incremental Move or Transform (Rotate, FlipX) Component.
 * @param compId component ID
 */
export async function moveComponentRoute(compId) {
	if (!_wb) { await buildAndRoute(); return; }
	const comp = S.components.find(c => c.id === compId);
	if (!comp) return;

	const incResult = _wb.moveComponent(compId, { position: { x: comp.x, y: comp.y }, transform: { rotation: comp.rotation || 0, flipX: comp.flipX || false } });

	// Extract affected nets into a standard JS array
	const affectedNets = [];
	for (let i = 0; i < incResult.affectedNets.size(); i++) {
		affectedNets.push(incResult.affectedNets.get(i));
	}

	// Apply only to the affected nets
	_applyRouteResult(incResult.routes, affectedNets);
	render();
}

/**
 * Replace Component (Symbol change).
 * @param comp component to replace
 * @param oldToNewMap pin mapping
 */
export async function replaceComponentRoute(comp, oldToNewMap) {
	if (!_wb) { await buildAndRoute(); return; }

	const desc = createComp(comp).wbDescriptor();
	const pinsVec = new _WB.VectorPinDescriptor();
	desc.pins.forEach(p => pinsVec.push_back({
		number: p.number,
		name: p.name,
		x: p.x,
		y: p.y,
		directionFlags: p.directionFlags,
	}));

	const mapObj = new _WB.PinMap();
	mapObj.fromObject(oldToNewMap);

	const replacement = {
		componentId: comp.id,
		newDescriptor: {
			id: desc.id,
			width: desc.width,
			height: desc.height,
			padding: desc.padding,
			pins: pinsVec
		},
		pinMapping: mapObj
	};

	const result = _wb.replaceComponent(replacement);
	_applyRouteResult(result);
	render();

	pinsVec.delete();
	mapObj.delete();
}

/**
 * Re-route after a manual drag or undo.
 * Fully syncs all component geometry AND positions into WireBender
 * before calling routeAll(). This handles any combination of:
 *	 - position changes (drag)
 *	 - transform changes (undo restoring a previous rotation/flipX)
 *
 * TODO: with changes to placement instead of position, not sure
 * that the fix described below needed.
 * The critical fix: routeWires() must call addComponent() (not just
 * setComponentPlacement()) for every component, because addComponent
 * replaces the geometry registration.	Using only setComponentPosition
 * leaves WireBender with stale pin geometry after rotation/undo, which
 * produces diagonal wire artifacts and wrong wire endpoints.
 */
export async function routeWires() {
	if (!S.components.length) return;
	if (!_wb) { await buildAndRoute(); return; }

	// Sync every component's current geometry and position.
	// addComponent() replaces the existing registration when called with
	// the same id — so this is always safe to call unconditionally.
	S.components.forEach(comp => {
		const desc = createComp(comp).wbDescriptor();
		const pinsVec = new _WB.VectorPinDescriptor();
		desc.pins.forEach(p => pinsVec.push_back({
			number: p.number,
			name: p.name,
			x: p.x,
			y: p.y,
			directionFlags: p.directionFlags,
		}));
		// TODO: check if needed with new setPlacement, find ui undo method and sync wirebender instead
		_wb.addComponent({
			id: desc.id,
			width: desc.width,
			height: desc.height,
			padding: desc.padding,
			pins: pinsVec,
		});
		pinsVec.delete();

		_wb.setComponentPlacement(comp.id, { position: { x: comp.x, y: comp.y }, transform: { rotation: comp.rotation || 0, flipX: comp.flipX || false } });
	});

	const result = _wb.routeAll();
	_applyRouteResult(result);
	render();
}
