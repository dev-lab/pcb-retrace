// ═══════════════════════════════════════════════════════════════
//	schema/db.js — Database layer for Schematic ReTrace
//
//	Opens the shared PcbReTrace IndexedDB at version 2.
//	Provides typed read/write methods for both existing Studio
//	stores (read-only from Schema's perspective) and the new
//	Schema ReTrace stores introduced in version 2.
//
//	Coordinate convention for stored positions:
//		x, y	— world-space centre coordinates (pixels, floating)
//		rotation — integer degrees (0, 90, 180, 270)
// ═══════════════════════════════════════════════════════════════

const DB_NAME = window.PcbDbCore.DB_NAME;
const DB_VER = window.PcbDbCore.DB_VER;

// ── uuid helper (shared from db-core.js) ────────────
export const uuid = window.uuid;

// ── Seed data ─────────────────────────────────────────────────
// pinDirections rows — id values intentionally match WireBender PinDirection flags.
const SEED_PIN_DIRECTIONS = [
	{ id: 0, name: 'None', description: 'No preferred direction', angle: null },
	{ id: 1, name: 'Up', description: 'Wire exits upward', angle: 270 },
	{ id: 2, name: 'Down', description: 'Wire exits downward', angle: 90 },
	{ id: 4, name: 'Left', description: 'Wire exits to the left', angle: 180 },
	{ id: 8, name: 'Right', description: 'Wire exits to the right', angle: 0 },
	{ id: 15, name: 'All', description: 'Router chooses best direction', angle: null },
];

// symbolTypes — classification tree.
// IDs are stable UUIDs so they can be referenced as FKs from componentTypes.
const ST_PASSIVE = 'st-passive-0000-0000-000000000001';
const ST_SEMI = 'st-semi-00000-0000-0000-000000000002';
const ST_IC = 'st-ic-000000-0000-0000-000000000003';
const ST_RESISTOR = 'st-resistor-00-0000-0000-000000000004';
const ST_CAPACITOR = 'st-capacitor-0-0000-0000-000000000005';
const ST_INDUCTOR = 'st-inductor-00-0000-0000-000000000006';
const ST_DIODE = 'st-diode-0000-0000-0000-000000000007';
const ST_ZENER = 'st-zener-0000-0000-0000-000000000008';
const ST_GENERIC_IC = 'st-generic-ic-0-000-0000-000000000009';

const SEED_SYMBOL_TYPES = [
	{ id: ST_PASSIVE, name: 'Passive', parentId: null },
	{ id: ST_SEMI, name: 'Semiconductor', parentId: null },
	{ id: ST_IC, name: 'IC', parentId: null },
	{ id: ST_RESISTOR, name: 'Resistor', parentId: ST_PASSIVE },
	{ id: ST_CAPACITOR, name: 'Capacitor', parentId: ST_PASSIVE },
	{ id: ST_INDUCTOR, name: 'Inductor', parentId: ST_PASSIVE },
	{ id: ST_DIODE, name: 'Diode', parentId: ST_SEMI },
	{ id: ST_ZENER, name: 'Zener Diode', parentId: ST_DIODE },
	{ id: ST_GENERIC_IC, name: 'Generic IC', parentId: ST_IC },
];

// componentTypes — built-in types matching components.js classes.
// Stable IDs so schemaComponents can reference them reliably.
export const CT_RESISTOR = 'ct-resistor-000-0000-0000-000000000001';
export const CT_CAPACITOR = 'ct-capacitor-0-0000-0000-000000000002';
export const CT_INDUCTOR = 'ct-inductor-00-0000-0000-000000000003';
export const CT_DIODE = 'ct-diode-0000-0000-0000-000000000004';
export const CT_ZENER = 'ct-zener-0000-0000-0000-000000000005';
export const CT_GENERIC_IC = 'ct-generic-ic-0-000-0000-000000000006';

// Maps the type key used in S.components[].type → componentType id
export const TYPE_KEY_TO_CT = {
	R: CT_RESISTOR,
	C: CT_CAPACITOR,
	L: CT_INDUCTOR,
	D: CT_DIODE,
	Z: CT_ZENER,
	IC: CT_GENERIC_IC,
};

const NOW = () => Date.now();

const SEED_COMPONENT_TYPES = [
	{ id: CT_RESISTOR, symbolTypeId: ST_RESISTOR, name: 'Resistor', pinCount: 2, created: 0, lastModified: 0 },
	{ id: CT_CAPACITOR, symbolTypeId: ST_CAPACITOR, name: 'Capacitor', pinCount: 2, created: 0, lastModified: 0 },
	{ id: CT_INDUCTOR, symbolTypeId: ST_INDUCTOR, name: 'Inductor', pinCount: 2, created: 0, lastModified: 0 },
	{ id: CT_DIODE, symbolTypeId: ST_DIODE, name: 'Diode', pinCount: 2, created: 0, lastModified: 0 },
	{ id: CT_ZENER, symbolTypeId: ST_ZENER, name: 'Zener Diode', pinCount: 2, created: 0, lastModified: 0 },
	{ id: CT_GENERIC_IC, symbolTypeId: ST_GENERIC_IC, name: 'Generic IC', pinCount: null, created: 0, lastModified: 0 },
];

// componentTypePins — pin positions in centre-origin local space (pixels).
// DirLeft=4, DirRight=8, DirUp=1, DirDown=2 (matches pinDirections.id).
// Dimensions match geometry defined in components.js:
//	 Resistor: 60×24	 Capacitor: 28×40	Inductor: 60×20	Diode/Zener: 44×24
const SEED_COMPONENT_TYPE_PINS = [
	// Resistor — horizontal, pins left/right at half-width
	{ id: uuid(), componentTypeId: CT_RESISTOR, number: 1, name: '1', description: null, x: -30, y: 0, directionId: 4 },
	{ id: uuid(), componentTypeId: CT_RESISTOR, number: 2, name: '2', description: null, x: 30, y: 0, directionId: 8 },
	// Capacitor — vertical, pins top/bottom at half-height
	{ id: uuid(), componentTypeId: CT_CAPACITOR, number: 1, name: '+', description: 'Positive / anode', x: 0, y: -20, directionId: 1 },
	{ id: uuid(), componentTypeId: CT_CAPACITOR, number: 2, name: '-', description: 'Negative / cathode', x: 0, y: 20, directionId: 2 },
	// Inductor — horizontal
	{ id: uuid(), componentTypeId: CT_INDUCTOR, number: 1, name: '1', description: null, x: -30, y: 0, directionId: 4 },
	{ id: uuid(), componentTypeId: CT_INDUCTOR, number: 2, name: '2', description: null, x: 30, y: 0, directionId: 8 },
	// Diode — Anode left, Cathode right
	{ id: uuid(), componentTypeId: CT_DIODE, number: 1, name: 'A', description: 'Anode', x: -22, y: 0, directionId: 4 },
	{ id: uuid(), componentTypeId: CT_DIODE, number: 2, name: 'K', description: 'Cathode', x: 22, y: 0, directionId: 8 },
	// Zener — same physical layout as Diode
	{ id: uuid(), componentTypeId: CT_ZENER, number: 1, name: 'A', description: 'Anode', x: -22, y: 0, directionId: 4 },
	{ id: uuid(), componentTypeId: CT_ZENER, number: 2, name: 'K', description: 'Cathode', x: 22, y: 0, directionId: 8 },
	// Generic IC — no fixed pins in type definition; pins are instance-specific
];

// ═══════════════════════════════════════════════════════════════
//	SchemaDatabase class
// ═══════════════════════════════════════════════════════════════
export class SchemaDatabase {
	constructor() {
		this._db = null;
	}

	// ── Initialise: open DB, upgrade if needed, seed static data ─
	async init() {
		await this._open();
		await this._seed();
		await this._migratePinCounts();
	}

	_open() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VER);

			req.onupgradeneeded = e => {
				console.log('[schema/db] onupgradeneeded — upgrading from v', e.oldVersion, '→', e.newVersion);
				window.PcbDbCore.setupDatabase(e.target.result, e.target.transaction);
			};
			req.onsuccess = e => { this._db = e.target.result; console.log('[schema/db] opened v', this._db.version); resolve(); };
			req.onerror = e => { console.error('[SchemaDB] Open error:', e); reject(e); };
		});
	}

	// ── Seed static lookup data on first run ──────────────────────
	async _seed() {
		// pinDirections — only seed if table is empty
		const existingDirs = await this._getAll('pinDirections');
		if (existingDirs.length === 0) {
			const tx = this._db.transaction('pinDirections', 'readwrite');
			const st = tx.objectStore('pinDirections');
			SEED_PIN_DIRECTIONS.forEach(d => st.put(d));
			await this._txDone(tx);
		}

		// symbolTypes — only seed if table is empty
		const existingSymTypes = await this._getAll('symbolTypes');
		if (existingSymTypes.length === 0) {
			const tx = this._db.transaction('symbolTypes', 'readwrite');
			const st = tx.objectStore('symbolTypes');
			SEED_SYMBOL_TYPES.forEach(s => st.put(s));
			await this._txDone(tx);
		}

		// componentTypes — only seed if table is empty
		const existingTypes = await this._getAll('componentTypes');
		if (existingTypes.length === 0) {
			const tx = this._db.transaction(['componentTypes', 'componentTypePins'], 'readwrite');
			SEED_COMPONENT_TYPES.forEach(t => tx.objectStore('componentTypes').put(t));
			SEED_COMPONENT_TYPE_PINS.forEach(p => tx.objectStore('componentTypePins').put(p));
			await this._txDone(tx);
		}
	}

	// ── Low-level helpers ─────────────────────────────────────────
	_tx(store, mode, cb) {
		return new Promise((resolve, reject) => {
			const t = this._db.transaction(store, mode);
			const q = cb(t.objectStore(store));
			q.onsuccess = () => resolve(q.result);
			q.onerror = () => reject(q.error);
		});
	}

	_ix(store, index, value) {
		return new Promise((resolve, reject) => {
			const q = this._db.transaction(store, 'readonly')
				.objectStore(store).index(index).getAll(value);
			q.onsuccess = () => resolve(q.result);
			q.onerror = () => reject(q.error);
		});
	}

	_getAll(store) {
		return this._tx(store, 'readonly', s => s.getAll());
	}

	_txDone(tx) {
		return new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
	}

	// ── Studio store reads (read-only from Schema's perspective) ──

	getDevice(id) {
		return this._tx('devices', 'readonly', s => s.get(id));
	}

	getDevices() {
		return this._getAll('devices');
	}

	getBoard(id) {
		return this._tx('boards', 'readonly', s => s.get(id));
	}

	getBoardsByDevice(deviceId) {
		return this._ix('boards', 'deviceId', deviceId);
	}

	/** All components belonging to a specific board. */
	getComponentsByBoard(boardId) {
		return this._ix('components', 'boardId', boardId);
	}

	/**
	 * All nets whose projectId matches boardId.
	 * Falls back to a full-table JS filter when the projectId index
	 * doesn't exist yet (DB still at v1 before Studio upgrade runs).
	 */
	async getNetsByBoard(boardId) {
		const store = this._db.transaction('nets', 'readonly').objectStore('nets');
		if (store.indexNames.contains('projectId')) {
			return this._ix('nets', 'projectId', boardId);
		}
		// Index not yet created — full scan + filter
		return new Promise((resolve, reject) => {
			const req = store.getAll();
			req.onsuccess = () => resolve((req.result || []).filter(n => n.projectId === boardId));
			req.onerror = () => reject(req.error);
		});
	}

	// ── Schemas ───────────────────────────────────────────────────

	/**
	 * Returns the existing schema for this board, or creates one.
	 * boardId may be null for device-level schemas.
	 */
	async getOrCreateSchema(deviceId, boardId) {
		// Try to find an existing schema for this board
		let existing = null;
		if (boardId) {
			const byBoard = await this._ix('schemas', 'boardId', boardId);
			existing = byBoard.find(s => s.deviceId === deviceId) || null;
		} else {
			// Device-level schema: boardId is null — find by deviceId with null boardId
			const byDevice = await this._ix('schemas', 'deviceId', deviceId);
			existing = byDevice.find(s => !s.boardId) || null;
		}
		if (existing) return existing;

		const schema = {
			id: uuid(),
			deviceId,
			boardId: boardId || null,
			name: 'Main Schema',
			created: NOW(),
			lastModified: NOW(),
			viewportZoom: 1,
			viewportX: 0,
			viewportY: 0,
		};
		await this._tx('schemas', 'readwrite', s => s.put(schema));
		return schema;
	}

	saveSchema(schema) {
		schema.lastModified = NOW();
		return this._tx('schemas', 'readwrite', s => s.put(schema));
	}

	// ── SchemaComponents ──────────────────────────────────────────

	getSchemaComponents(schemaId) {
		return this._ix('schemaComponents', 'schemaId', schemaId);
	}

	saveSchemaComponent(sc) {
		return this._tx('schemaComponents', 'readwrite', s => s.put(sc));
	}

	deleteSchemaComponent(id) {
		return this._tx('schemaComponents', 'readwrite', s => s.delete(id));
	}

	/**
	 * Upsert a schemaComponent record for a given component within a schema.
	 * Creates a new record if none exists, updates existing one if found.
	 * Sets locked=true so this position survives future auto-layouts.
	 */
	async upsertSchemaComponent(schemaId, componentId, { x, y, rotation, flipX, componentTypeId, pinCount, overrides } = {}) {
		const existing = await this._findSchemaComponent(schemaId, componentId);
		const sc = existing || {
			id: uuid(),
			schemaId,
			componentId,
			componentTypeId: null,
			pinCount: null,
			overrides: null,
		};
		// Always update position/rotation/lock
		sc.x = x;
		sc.y = y;
		sc.rotation = rotation;		// degrees
		sc.flipX = flipX;
		sc.locked = true;
		if (componentTypeId !== undefined) sc.componentTypeId = componentTypeId;
		if (pinCount !== undefined) sc.pinCount = pinCount;
		if (overrides !== undefined) sc.overrides = overrides;
		return this._tx('schemaComponents', 'readwrite', s => s.put(sc));
	}

	/** Find a schemaComponent record for a specific component within a schema. */
	async findSchemaComponent(schemaId, componentId) {
		const all = await this._ix('schemaComponents', 'schemaId', schemaId);
		return all.find(sc => sc.componentId === componentId) || null;
	}

	async createMissingComponent(boardId, label, value) {
		const id = uuid();
		await this._tx('components', 'readwrite', s => s.put(
			{ id, boardId, label, value, desc: '' }
		));
		return id;
	}

	// Keep private alias for internal use
	_findSchemaComponent(schemaId, componentId) {
		return this.findSchemaComponent(schemaId, componentId);
	}

	// ── KiCad Symbols ─────────────────────────────────────────────
	async getKicadSymbols(library) {
		return this._ix('kicadSymbols', 'library', library);
	}

	async getKicadSymbolsByPinCount(pinCount) {
		return this._ix('kicadSymbols', 'pinCount', pinCount);
	}

	async _migratePinCounts() {
		const syms = await this._getAll('kicadSymbols');
		const needsMigration = syms.filter(s => s.pinCount === undefined);
		if (needsMigration.length === 0) return;

		console.log(`[schema/db] Migrating ${needsMigration.length} KiCad symbols to add pinCount...`);
		const tx = this._db.transaction('kicadSymbols', 'readwrite');
		const st = tx.objectStore('kicadSymbols');
		for (const s of needsMigration) {
			try {
				const parsed = JSON.parse(s.parsedData);
				s.pinCount = parsed.pins ? parsed.pins.length : 0;
				st.put(s);
			} catch (e) {
				console.warn('Failed to migrate symbol', s.id);
			}
		}
		await this._txDone(tx);
		console.log('[schema/db] Migration complete.');
	}

	async saveKicadSymbol(sym) {
		return this._tx('kicadSymbols', 'readwrite', s => s.put(sym));
	}

	async saveKicadSymbolsBatch(syms) {
		const tx = this._db.transaction('kicadSymbols', 'readwrite');
		const st = tx.objectStore('kicadSymbols');
		syms.forEach(sym => st.put(sym));
		return this._txDone(tx);
	}

	async saveComponentType(ct) {
		return this._tx('componentTypes', 'readwrite', s => s.put(ct));
	}

	async saveComponentTypeKicadSymbol(ctks) {
		return this._tx('componentTypeKicadSymbols', 'readwrite', s => s.put(ctks));
	}

	async getKicadSymbolById(id) {
		return this._tx('kicadSymbols', 'readonly', s => s.get(id));
	}

	async getComponentTypeForKicadSymbol(kicadSymbolId) {
		const links = await this._ix('componentTypeKicadSymbols', 'kicadSymbolId', kicadSymbolId);
		if (links && links.length > 0) return this.getComponentType(links[0].componentTypeId);
		return null;
	}

	async getResolvedKicadDataForComponentType(componentTypeId) {
		const links = await this._ix('componentTypeKicadSymbols', 'componentTypeId', componentTypeId);
		if (!links || links.length === 0) return null;
		return this.getKicadSymbolById(links[0].kicadSymbolId);
	}

	// ── Component type catalogue ──────────────────────────────────

	getComponentTypes() {
		return this._getAll('componentTypes');
	}

	getComponentType(id) {
		return this._tx('componentTypes', 'readonly', s => s.get(id));
	}

	getComponentTypePins(componentTypeId) {
		return this._ix('componentTypePins', 'componentTypeId', componentTypeId);
	}

	getPinDirections() {
		return this._getAll('pinDirections');
	}

	getSymbolTypes() {
		return this._getAll('symbolTypes');
	}

	// ── Standalone netlist import ─────────────────────────────────
	/**
	 * Creates a device + board + components + nets in one logical operation.
	 * The netlist is in Schema ReTrace's internal parsed format:
	 *	 { components: [{ref, value, type}], nets: [{name, nodes:[{ref,pin}]}] }
	 * Returns { deviceId, boardId }.
	 */
	async importNetlist(name, parsed) {
		const deviceId = uuid();
		const boardId = uuid();
		const ts = NOW();

		// Build component records — map ref → id for net node resolution
		const refToId = {};
		const compRecords = parsed.components.map(c => {
			const id = uuid();
			refToId[c.ref] = id;
			return { id, boardId, label: c.ref, value: c.value || '', desc: '' };
		});

		// Build net records using Studio's format (nodes as "ref.pin" label strings)
		const netRecords = parsed.nets.map(n => ({
			id: uuid(),
			projectId: boardId,
			name: n.name,
			nodes: (n.nodes || []).map(nd => ({ label: `${nd.ref}.${nd.pin}` })),
		}));

		// Single transaction for atomicity
		const stores = ['devices', 'boards', 'components', 'nets'];
		const tx = this._db.transaction(stores, 'readwrite');
		tx.objectStore('devices').put({ id: deviceId, name });
		tx.objectStore('boards').put({
			id: boardId, deviceId,
			name: 'Main Board',
			section: '', sortMode: 'none', lastModified: ts,
		});
		compRecords.forEach(c => tx.objectStore('components').put(c));
		netRecords.forEach(n => tx.objectStore('nets').put(n));
		await this._txDone(tx);

		return { deviceId, boardId };
	}
}

// ── Module-level singleton ────────────────────────────────────
export const db = new SchemaDatabase();
