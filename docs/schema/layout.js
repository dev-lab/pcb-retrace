/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

/*
 * layout.js — WireBender placement + routing, executed in a cancellable Worker.
 * See router-worker.js. Any new change kills in-flight routing; the next route
 * runs after the last change (debounced) and is a full re-sync if state was lost.
 */
import { S } from './state.js';
import { createComp } from './components.js';
import { render } from './draw.js';

const DEBOUNCE_MS = 120;
const CANCELLED = Symbol('cancelled');

let _worker = null;
let _workerValid = false;		// does the worker hold live router state matching S?
let _needFull = true;
let _seq = 0;
let _inflight = null;			// { cancellable, waiters }
let _timer = null;
let _waiters = [];
let _pendingReplaces = [];
const _pendingMoves = new Set();
let _placementTail = Promise.resolve();

// ── Worker lifecycle ──────────────────────────────────────────
function _spawn() {
	const w = new Worker(new URL('./router-worker.js', import.meta.url), { type: 'module' });
	w._calls = new Map();
	w.onmessage = e => {
		const { id, ok, result, error } = e.data;
		const c = w._calls.get(id);
		if (!c) return;
		w._calls.delete(id);
		ok ? c.resolve(result) : c.reject(new Error(error));
	};
	w.onerror = e => {
		console.error('[router] worker error', e);
		w._calls.forEach(c => c.reject(new Error('worker error')));
		w._calls.clear();
		if (_worker === w) { _workerValid = false; _needFull = true; }
	};
	_worker = w;
	_workerValid = false;
	return w;
}

/** Warm up the worker (called at startup). */
export function initWireBender() { if (!_worker) _spawn(); }

function _call(msg) {
	const w = _worker || _spawn();
	const id = ++_seq;
	return new Promise((resolve, reject) => {
		w._calls.set(id, { resolve, reject });
		w.postMessage({ id, ...msg });
	});
}

/** Hard-cancel: terminate the worker mid-computation, spawn a warm replacement. */
function _kill() {
	const w = _worker;
	if (!w) return;
	w.terminate();
	w._calls.forEach(c => c.reject(CANCELLED));
	w._calls.clear();
	_needFull = true;		// libavoid state is gone → next route must fully re-sync
	_spawn();
}

// ── Model serialisation (plain data only) ─────────────────────
function _placement(c) {
	return { position: { x: c.x, y: c.y }, transform: { rotation: c.rotation || 0, flipX: c.flipX || false } };
}

function _placementsFromS() {
	const o = {};
	S.components.forEach(c => { o[c.id] = _placement(c); });
	return o;
}

function _buildModel() {
	const components = S.components.map(c => createComp(c).wbDescriptor());
	const nets = [];
	S.nets.forEach(net => {
		const nodes = (net.nodes || []).filter(nd => S.components.find(c => c.ref === nd.ref));
		if (nodes.length < 2) return;
		const pins = [];
		nodes.forEach(nd => {
			const comp = S.components.find(c => c.ref === nd.ref);
			const idx = comp.pins.findIndex(p =>
				p.originalName === nd.pin || p.originalName === String(nd.pin) ||
				p.name === nd.pin || p.name === String(nd.pin));
			pins.push({ componentId: comp.id, pinNumber: idx >= 0 ? idx + 1 : 1 });
		});
		nets.push({ name: net.name, pins });
	});
	return { components, nets };
}

// ── Apply plain results into S ────────────────────────────────
function _applyRouteResult(result, affectedNets = null) {
	const byNet = {};
	const slot = n => (byNet[n] ||= { wires: [], junctions: [] });

	result.wires.forEach(w => { if (w.points.length >= 2) slot(w.net).wires.push(w.points); });
	result.junctions.forEach(j => slot(j.net).junctions.push({ x: j.position.x, y: j.position.y }));

	const applyNet = netName => {
		const nd = byNet[netName];
		if (!nd) return;
		S.wires = S.wires.filter(w => w.net !== netName);
		S.junctionPoints = (S.junctionPoints || []).filter(jp => jp.net !== netName);
		let seq = 0;
		nd.wires.forEach(pts => S.wires.push({ id: `wb_${netName}_${seq++}`, net: netName, points: pts, pinA: null, pinB: null }));
		nd.junctions.forEach(j => S.junctionPoints.push({ x: j.x, y: j.y, net: netName }));
	};

	if (affectedNets) {
		affectedNets.forEach(applyNet);
	} else {
		S.wires = [];
		S.junctionPoints = [];
		Object.keys(byNet).forEach(applyNet);
	}

	S.componentLabels = {};
	(result.componentLabels || []).forEach(h => {
		S.componentLabels[h.componentId] = {
			refPosition: h.refPosition, refIsVertical: h.refIsVertical,
			valuePosition: h.valuePosition, valueIsVertical: h.valueIsVertical,
		};
	});

	_applyWipStubs();
}

function _applyWipStubs() {
	S.nets.forEach(net => {
		if ((net.nodes || []).length !== 1) return;
		const nd = net.nodes[0];
		const comp = S.components.find(c => c.ref === nd.ref);
		if (!comp) return;
		const pins = createComp(comp).pinPositions();
		const pinIdx = comp.pins.findIndex(p =>
			p.originalName === nd.pin || p.originalName === String(nd.pin) ||
			p.name === nd.pin || p.name === String(nd.pin));
		const p = pins[pinIdx >= 0 ? pinIdx : 0];
		if (!p) return;
		S.wires = S.wires.filter(w => w.id !== `wip_${net.name}`);
		S.wires.push({
			id: `wip_${net.name}`, net: net.name,
			points: [{ x: p.x, y: p.y }, { x: p.x + p.ex * 32, y: p.y + p.ey * 32 }],
			pinA: { compId: comp.id, pinName: p.pinName }, pinB: null,
		});
	});
}

function _applyPlacements(placements) {
	for (const id in placements) {
		const pl = placements[id];
		const comp = S.components.find(c => c.id === id);
		if (!comp) continue;
		comp.x = pl.position.x;
		comp.y = pl.position.y;
		comp.rotation = pl.transform.rotation;
		comp.flipX = pl.transform.flipX;
	}
}

// ── Scheduler: cancel on change, route after last change ──────
function _schedule() {
	if (_inflight) {
		if (!_inflight.cancellable) return;	  // placement run: finishes first, then re-schedules
		_kill();							  // cancel immediately
	}
	clearTimeout(_timer);
	_timer = setTimeout(_dispatch, DEBOUNCE_MS);
}

function _requestRoute({ moves = [], replace = null, full = false }) {
	if (full) _needFull = true;
	moves.forEach(id => _pendingMoves.add(id));
	if (replace) _pendingReplaces.push(replace);
	return new Promise(res => { _waiters.push(res); _schedule(); });
}

async function _dispatch() {
	_timer = null;
	if (_inflight || _waiters.length === 0) return;

	const full = _needFull || !_workerValid;
	let msg;
	if (full) {
		msg = { type: 'build', model: _buildModel(), placements: _placementsFromS(), runPlacement: false };
	} else {
		const ops = [];
		for (const r of _pendingReplaces) {
			const c = S.components.find(x => x.id === r.compId);
			if (c) ops.push({ op: 'replace', compId: c.id, desc: createComp(c).wbDescriptor(), pinMap: r.pinMap });
		}
		for (const id of _pendingMoves) {
			const c = S.components.find(x => x.id === id);
			if (c) ops.push({ op: 'move', compId: id, placement: _placement(c) });
		}
		msg = { type: 'incremental', ops };
	}
	_pendingMoves.clear();
	_pendingReplaces = [];
	_needFull = false;

	const job = { cancellable: true, waiters: _waiters.splice(0) };
	_inflight = job;
	let settled = true;
	try {
		const res = await _call(msg);
		_workerValid = true;
		if (full) _applyRouteResult(res.route);
		else res.results.forEach(r => _applyRouteResult(r.route, r.affected));
		render();
	} catch (err) {
		if (err === CANCELLED) {
			_waiters.unshift(...job.waiters);	// a newer route will answer them
			settled = false;
		} else {
			console.error('[router] routing failed:', err);
			_needFull = true;
			import('./ui.js').then(({ toast }) => toast('Routing failed — see console', 'err'));
		}
	} finally {
		if (_inflight === job) _inflight = null;
	}
	if (settled) job.waiters.forEach(r => r());
	if (_waiters.length) _schedule();
}

// ── Viewport ──────────────────────────────────────────────────
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

// ── Public API  ───────────────────────────────────────────────

/**
 * Full build. runPlacement=true runs auto-placement (not cancellable, returns
 * placements). runPlacement=false just re-routes at current S positions
 * (cancellable, coalesced).
 */
export async function buildAndRoute(lockedPlacements = {}, runPlacement = true) {
	if (!S.components.length) { render(); return {}; }
	if (!runPlacement) { await _requestRoute({ full: true }); return {}; }

	const run = async () => {
		// Placement supersedes everything pending
		clearTimeout(_timer);
		_pendingMoves.clear();
		_pendingReplaces = [];
		if (_inflight && _inflight.cancellable) _kill();

		const job = { cancellable: false, waiters: [] };
		_inflight = job;
		try {
			const res = await _call({
				type: 'build', model: _buildModel(), placements: null,
				locks: lockedPlacements, runPlacement: true,
			});
			_workerValid = true;
			_needFull = false;
			_applyPlacements(res.placements);
			_applyRouteResult(res.route);
			fitView();
			return res.placements;
		} catch (err) {
			console.error('[router] placement failed:', err);
			_needFull = true;
			import('./ui.js').then(({ toast }) => toast('Layout failed — see console', 'err'));
			return {};
		} finally {
			if (_inflight === job) _inflight = null;
			if (_waiters.length) _schedule();
		}
	};
	// serialise placement runs
	const p = _placementTail.then(run);
	_placementTail = p.catch(() => {});
	return p;
}

/** Component moved / rotated / flipped (S already updated). */
export function moveComponentRoute(compId) {
	return _requestRoute({ moves: [compId] });
}

/** Symbol replaced (S already updated). */
export function replaceComponentRoute(comp, oldToNewMap) {
	return _requestRoute({ replace: { compId: comp.id, pinMap: oldToNewMap } });
}

/** Full re-sync + route (undo, manual re-route). */
export function routeWires() {
	if (!S.components.length) return Promise.resolve();
	return _requestRoute({ full: true });
}
