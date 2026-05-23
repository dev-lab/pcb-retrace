// ── App entry point ───────────────────────────────────────────
import { autoImportDeviceLib } from './kicad.js';
import { S, NET_COLORS, initCanvas } from './state.js';
import { classifyComp } from './components.js';
import { buildAndRoute, initWireBender, fitView, routeWires } from './layout.js';
import { render } from './draw.js';
import { initInteraction } from './interaction.js';
import { pushHistory } from './history.js';
import { initUI, updateSidePanels, setStatus } from './ui.js';
import { initPostMessageListener, setIOCallbacks } from './io.js';
import { parseFromStudioDB, parseFileContent } from './parsers.js';
import { db, TYPE_KEY_TO_CT } from './db.js';

// ── Mode detection ────────────────────────────────────────────
// embedded:	?embed=true	 — running inside Studio iframe
// standalone: no params	— direct URL, show full import UI
const _params = new URLSearchParams(window.location.search);
export const MODE = _params.get('embed') ? 'embedded' : 'standalone';
export const BOARD_ID = _params.get('boardId') || null;
export const DEV_ID = _params.get('deviceId') || null;

// ── Session state ─────────────────────────────────────────────
// Holds the currently active schema record and the map of
// componentId (Studio) → schemaComponent record.
let _schema = null;		// schemas record
let _schemaCompMap = {};			// { [studioComponentId]: schemaComponent }
let _studioIdToS = {};			// { [studioComponentId]: S.components entry }

// Viewport save debounce timer
let _vpTimer = null;

let _pendingBoardId = null, _pendingDeviceId = null;

export function applyPinOverrides(comp) {
	if (comp.type !== 'KICAD' || !comp.kicadData || !comp.kicadData.pins) return;
	const kPins = comp.kicadData.pins;

	comp.pins.forEach((p, i) => {
		let targetKicadPinNum = kPins[i] ? kPins[i].num : null;

		if (comp.overrides?.type === 'shift') {
			const offset = comp.overrides.offset;
			const targetIdx = (i + offset) % kPins.length;
			const safeIdx = targetIdx < 0 ? targetIdx + kPins.length : targetIdx;
			targetKicadPinNum = kPins[safeIdx] ? kPins[safeIdx].num : targetKicadPinNum;
		} else if (comp.overrides?.type === 'remap') {
			if (comp.overrides.map && comp.overrides.map[p.originalName]) {
				targetKicadPinNum = comp.overrides.map[p.originalName];
			}
		}

		if (targetKicadPinNum) p.name = targetKicadPinNum;
	});
}

/**
 * Load a board from IndexedDB.
 */
export async function loadBoard(boardId, deviceId) {
	if (!boardId) {
		console.warn('[schema] loadBoard called with no boardId');
		S.hasData = false;
		S.components = [];
		S.nets = [];
		S.wires = [];
		S.junctionPoints = [];
		updateSidePanels();
		setStatus('No board selected', 'warn');
		render();
		return;
	}
	if (!db._db) {
		_pendingBoardId = boardId;
		_pendingDeviceId = deviceId;
		//console.log('[schema] DB not ready, queuing loadBoard');
		return;
	}

	setStatus('Loading…', '');
	try {
		const [studioComps, studioNets] = await Promise.all([
			db.getComponentsByBoard(boardId),
			db.getNetsByBoard(boardId),
		]);

		if (!studioComps.length && !studioNets.length) {
			S.hasData = false;
			S.components = [];
			S.nets = [];
			S.wires = [];
			S.junctionPoints = [];
			updateSidePanels();
			render();
			setStatus('No components or nets on this board yet', 'warn');
			return;
		}

		const parsed = parseFromStudioDB(studioComps, studioNets);

		// Get or create schema record
		_schema = await db.getOrCreateSchema(deviceId || DEV_ID, boardId);

		// Load saved layout
		const savedScs = await db.getSchemaComponents(_schema.id);
		_schemaCompMap = {};
		savedScs.forEach(sc => { _schemaCompMap[sc.componentId] = sc; });

		// Restore viewport
		S.zoom = _schema.viewportZoom || 1;
		S.viewX = _schema.viewportX || 0;
		S.viewY = _schema.viewportY || 0;

		// Ingest parsed netlist into S
		await _ingestParsed(parsed, studioComps, boardId);

		setStatus(
			`Loaded ${S.components.length} components, ${S.nets.length} nets`,
			'ok',
			`${S.components.length}📦 ${S.nets.length}〰`
		);
	} catch (err) {
		console.error('[app] loadBoard error:', err);
		setStatus('Load error — see console', 'err');
	}
}

export async function resetLayout() {
	if (!_schema) return;
	const scs = await db.getSchemaComponents(_schema.id);
	for (const sc of scs) await db.deleteSchemaComponent(sc.id);
	_schemaCompMap = {};
	await buildAndRoute({});
}

export function hasLayoutData() {
	return Object.keys(_schemaCompMap).length > 0;
}

/**
 * Ingest a parsed netlist into S and run layout.
 *
 * Used by both loadBoard (DB-backed) and importNetlistStandalone (file).
 * @param studioComps used to link S.components back to Studio IDs
 */
async function _ingestParsed(parsed, studioComps = [], boardId = null) {
	pushHistory();

	// Auto-add refs mentioned in nets but absent from components
	const known = new Set(parsed.components.map(c => c.ref));
	parsed.nets.forEach(net =>
		(net.nodes || []).forEach(nd => {
			if (nd.ref && !known.has(nd.ref)) {
				parsed.components.push({ ref: nd.ref, value: '', type: classifyComp(nd.ref) });
				known.add(nd.ref);
			}
		})
	);

	const studioIdByRef = {};
	studioComps.forEach(c => { studioIdByRef[c.label] = c.id; });
	// Create DB records for any refs mentioned in nets/components but missing from components table
	for (const c of parsed.components) {
		if (!studioIdByRef[c.ref]) {
			const newId = await db.createMissingComponent(boardId, c.ref, c.value || '');
			studioIdByRef[c.ref] = newId;
			//console.log('[schema] created missing component in DB:', c.ref, newId);
		}
	}

	// Deduplicate and merge nets by name to prevent multiple entries for the same net
	const netRegistry = new Map();
	parsed.nets.forEach(n => {
		if (!netRegistry.has(n.name)) {
			netRegistry.set(n.name, { name: n.name, nodes: [] });
		}
		const targetNet = netRegistry.get(n.name);
		(n.nodes || []).forEach(newNode => {
			// Only add node if it's not already registered in this net (ref + pin)
			const isDuplicate = targetNet.nodes.some(en => en.ref === newNode.ref && en.pin === newNode.pin);
			if (!isDuplicate) targetNet.nodes.push(newNode);
		});
	});
	parsed.nets = Array.from(netRegistry.values());

	// Build pin→net map
	const pinMap = {}, compPins = {};
	parsed.nets.forEach(net =>
		(net.nodes || []).forEach(nd => {
			if (!pinMap[nd.ref]) pinMap[nd.ref] = {};
			if (!compPins[nd.ref]) compPins[nd.ref] = new Set();
			pinMap[nd.ref][nd.pin] = net.name;
			compPins[nd.ref].add(nd.pin);
		})
	);

	// Prepare KiCad data mappings for previously replaced components
	const kicadDataMap = {};
	for (const comp of parsed.components) {
		const studioId = studioIdByRef[comp.ref] || comp.studioId;
		const sc = studioId ? _schemaCompMap[studioId] : null;
		if (sc && sc.componentTypeId) {
			const kSym = await db.getResolvedKicadDataForComponentType(sc.componentTypeId);
			if (kSym && kSym.parsedData) {
				kicadDataMap[comp.ref] = {
					componentTypeId: sc.componentTypeId,
					kicadData: { name: kSym.symbol, ...JSON.parse(kSym.parsedData) }
				};
			}
		}
	}

	let seenRefs = new Set();
	S.components = parsed.components.filter(c => c.ref).map((c, i) => {
		const type = c.type || classifyComp(c.ref);

		let cId = c.ref;
		if (seenRefs.has(cId)) cId = `${c.ref}_${i}`;
		seenRefs.add(cId);

		const studioId = studioIdByRef[c.ref] || c.studioId || null;
		if (!studioId) console.warn('[schema] no studioId for ref:', c.ref);
		const saved = studioId ? _schemaCompMap[studioId] : null;

		const pinSet = compPins[c.ref] || new Set(['1', '2']);
		let pinNames = [...pinSet];
		pinNames.sort((a, b) => {
			const na = parseInt(a), nb = parseInt(b);
			if (!isNaN(na) && !isNaN(nb)) return na - nb;
			return a < b ? -1 : a > b ? 1 : 0;
		});
		const maxPin = Math.max(
			...Array.from(pinSet)
				.map(p => parseInt(p))
				.filter(n => !isNaN(n))
		);
		// Ensure pinCount is at least the highest numerical pin ID,
		// the total number of unique pins found, or the previously saved count.
		const highestPinId = isFinite(maxPin) ? maxPin : 0;
		let targetPinCount = Math.max(
			saved?.pinCount || 0,
			pinNames.length,
			highestPinId
		);
		if (['R', 'C', 'L', 'D', 'Z'].includes(type) && targetPinCount < 2) {
			targetPinCount = 2;
		}

		let nextPin = 1;
		while (pinNames.length < targetPinCount) {
			if (!pinNames.includes(String(nextPin))) pinNames.push(String(nextPin));
			nextPin++;
		}

		// Re-sort after adding missing pins to ensure they map index-for-index chronologically
		pinNames.sort((a, b) => {
			const na = parseInt(a), nb = parseInt(b);
			if (!isNaN(na) && !isNaN(nb)) return na - nb;
			return a < b ? -1 : a > b ? 1 : 0;
		});

		const pins = pinNames.map(pn => ({
			name: pn,
			originalName: pn,
			net: pinMap[c.ref]?.[pn] || null,
		}));

		const kd = kicadDataMap[c.ref];
		const overrides = saved?.overrides ? JSON.parse(saved.overrides) : null;

		return {
			id: cId,
			ref: c.ref,
			value: c.value || '',
			type: kd ? 'KICAD' : type,
			componentTypeId: kd ? kd.componentTypeId : null,
			kicadData: kd ? kd.kicadData : null,
			overrides: overrides,
			x: saved ? saved.x : 0,
			y: saved ? saved.y : 0,
			rotation: saved ? saved.rotation : 0,
			flipX: saved ? saved.flipX : false,
			pins,
			studioId,
		};
	});

	// Apply mappings before filtering un-netted components
	S.components.forEach(comp => applyPinOverrides(comp));
	// Don't show components without any connection
	S.components = S.components.filter(c => c.pins.some(p => p.net !== null));

	S.nets = parsed.nets.map((n, i) => ({
		name: n.name,
		nodes: n.nodes || [],
		color: NET_COLORS[i % NET_COLORS.length],
		isWip: (n.nodes || []).length <= 1,
	}));

	S.hasData = true;
	S.selectedComp = null;
	S.selectedNet = null;
	S.wires = [];
	S.junctionPoints = [];

	// Build lockedPositions keyed by S.components id (not studioId)
	// WireBender uses S.components[].id as componentId in addComponent()
	const wbLocks = {};
	S.components.forEach(comp => {
		if (!comp.studioId) return;
		const sc = _schemaCompMap[comp.studioId];
		if (sc?.locked) wbLocks[comp.id] = {
			position: {x: sc.x, y: sc.y},
			transform: {rotation: sc.rotation, flipX: sc.flipX} };
	});

	// buildAndRoute returns placed positions for new (unlocked) components
	const hasNewComps = S.components.some(comp =>
		comp.studioId && !_schemaCompMap[comp.studioId]
	);
	const placed = await buildAndRoute(wbLocks, hasNewComps);

	// Persist newly placed components that had no schemaComponent record yet
	if (_schema) {
		const newComps = S.components.filter(comp => {
			if (!comp.studioId) return false;
			return !_schemaCompMap[comp.studioId];
		});
		for (const comp of newComps) {
			const pl = placed[comp.id] || { x: comp.x, y: comp.y };
			await db.upsertSchemaComponent(_schema.id, comp.studioId, {
				x: pl.position.x,
				y: pl.position.y,
				rotation: pl.transform.rotation,
				flipX: pl.transform.flipX,
				componentTypeId: TYPE_KEY_TO_CT[comp.type] || null,
				pinCount: comp.pins.length,
			});
			// Mark as not locked — WireBender placed it, user hasn't touched it
			const sc = await db._findSchemaComponent(_schema.id, comp.studioId);
			if (sc) { sc.locked = false; await db.saveSchemaComponent(sc); }
		}
	}

	updateSidePanels();
}

// ── Autosave: component layout after drag or rotation ─────────
// Called by interaction.js after every drag-drop and rotation.
// compId is S.components[].id (not studioId).
export async function saveComponentLayout(compId) {
	if (!_schema) return;
	const comp = S.components.find(c => c.id === compId);
	// console.log('[schema] saveComponentLayout', compId,
	//	'studioId:', comp?.studioId,
	//	'ref:', comp?.ref,
	//	'x:', comp?.x, 'y:', comp?.y);
	if (!comp?.studioId) return;
	await db.upsertSchemaComponent(_schema.id, comp.studioId, {
		x: comp.x, y: comp.y, rotation: comp.rotation, flipX: comp.flipX,
		componentTypeId: comp.componentTypeId || TYPE_KEY_TO_CT[comp.type] || null,
		pinCount: comp.pins.length,
		overrides: comp.overrides ? JSON.stringify(comp.overrides) : null
	});
	// Save all other components that don't have a record yet
	// so the whole layout is preserved after the first user interaction
	for (const c of S.components) {
		if (!c.studioId || c.id === compId) continue;
		const existing = await db._findSchemaComponent(_schema.id, c.studioId);
		if (!existing) {
			await db.upsertSchemaComponent(_schema.id, c.studioId, {
				x: c.x, y: c.y, rotation: c.rotation, flipX: c.flipX,
				componentTypeId: c.componentTypeId || TYPE_KEY_TO_CT[c.type] || null,
				pinCount: c.pins.length,
				overrides: c.overrides ? JSON.stringify(c.overrides) : null
			});
		}
	}
	// Refresh local cache
	const savedScs = await db.getSchemaComponents(_schema.id);
	_schemaCompMap = {};
	savedScs.forEach(sc => { _schemaCompMap[sc.componentId] = sc; });
}

// ── Autosave: viewport after pan/zoom ─────────────────────────
// Debounced — writes at most once per 500ms.
export function saveViewport() {
	if (!_schema) return;
	clearTimeout(_vpTimer);
	_vpTimer = setTimeout(async () => {
		_schema.viewportZoom = S.zoom;
		_schema.viewportX = S.viewX;
		_schema.viewportY = S.viewY;
		await db.saveSchema(_schema);
	}, 500);
}

// ── Standalone: import a netlist file and create DB records ───
export async function importNetlistStandalone(text, filename) {
	try {
		const parsed = parseFileContent(text);
		const name = (filename || 'Imported Netlist')
			.replace(/\.[^.]+$/, '');	 // strip extension
		const { boardId, deviceId } = await db.importNetlist(name, parsed);
		localStorage.setItem('pcb_device_id', deviceId);
		localStorage.setItem('pcb_board_id', boardId);

		// Reset schema-session state so loadBoard creates a fresh schema
		_schema = null;
		_schemaCompMap = {};

		await loadBoard(boardId, deviceId);
		setStatus(
			`Imported "${name}" — ${S.components.length} components`,
			'ok',
			`Imported: ${S.components.length}📦`
		);
	} catch (err) {
		console.error('[app] importNetlistStandalone error:', err);
		setStatus('Import error: ' + err.message, 'err');
		import('./ui.js').then(({ toast }) => toast('Import failed — see status bar', 'err'));
	}
}

// ── Canvas resize handler ─────────────────────────────────────
function resizeCanvas() {
	const wrap = document.getElementById('canvas-wrap');
	const canvas = document.getElementById('sch-canvas');
	if (!wrap || !canvas) return;
	const w = wrap.clientWidth;
	const h = wrap.clientHeight;
	if (w > 0 && h > 0) {
		canvas.width = w;
		canvas.height = h;
		if (S.hasData) fitView();
		else render();
	}
}

export function triggerResize(w, h) {
	resizeCanvas();
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
	const canvas = document.getElementById('sch-canvas');
	if (!canvas) { console.error('[schema] #sch-canvas not found'); return; }

	initPostMessageListener();
	setIOCallbacks(loadBoard);
	initCanvas(canvas);
	new ResizeObserver(entries => {
		// console.log('[schema] ResizeObserver fired, wrap:',
		//	entries[0].contentRect.width, entries[0].contentRect.height);
		resizeCanvas();
	}).observe(document.getElementById('canvas-wrap'));

	// Initialise DB (opens connection, runs upgrade if needed, seeds data)
	try {
		// console.log('[schema] opening DB…');
		await db.init();
		// console.log('[schema] DB ready');

		// Background task: ensure standard KiCad library is available
		autoImportDeviceLib();

		if (_pendingBoardId) {
			await loadBoard(_pendingBoardId, _pendingDeviceId);
			_pendingBoardId = null;
			_pendingDeviceId = null;
		}
	} catch (err) {
		console.error('[app] DB init failed:', err);
		setStatus('Database error — see console', 'err');
		// Don't return — allow rendering even without DB
	}

	// Begin loading WASM in background
	initWireBender();

	initInteraction(saveComponentLayout, saveViewport);
	initUI(MODE, importNetlistStandalone, resetLayout, hasLayoutData);
	// console.log('[schema] init complete');

	// Size the canvas now (synchronous) so the first render has real dimensions.
	// The setTimeout fallback handles any post-layout resize.
	resizeCanvas();

	try {
		if (MODE === 'standalone' && !window._embeddedMode && !S.hasData) {
			setStatus('Import a netlist or switch to PCB ReTrace', 'warn');
			render();
		} else {
			render();
		}
	} catch (err) {
		console.error('[schema] post-init error:', err);
	}
});
