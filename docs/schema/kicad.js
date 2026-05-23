/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

import { db, uuid } from './db.js';

const SCALE = 20 / 2.54;
//const ZIP_URL = 'https://gitlab.com/kicad/libraries/kicad-symbols/-/archive/master/kicad-symbols-master.zip'; // CORS issue
const ZIP_URL = './assets/kicad-symbols-master.zip';

// ── S-Expression Parser ─────────────────────────────────────────
function parseSexpr(str) {
	const tokens =[]; let i = 0;
	while (i < str.length) {
		const c = str[i];
		if (c === '(' || c === ')') { tokens.push(c); i++; }
		else if (/\s/.test(c)) { i++; }
		else if (c === '"') {
			let s = '"'; i++;
			while (i < str.length) {
				if (str[i] === '\\') { s += str[i] + str[i+1]; i += 2; continue; }
				if (str[i] === '"') { s += '"'; i++; break; }
				s += str[i]; i++;
			}
			tokens.push(s);
		} else {
			let s = '';
			while (i < str.length && !/[\s()]/.test(str[i]) && str[i] !== '"') { s += str[i]; i++; }
			tokens.push(s);
		}
	}

	let ti = 0;
	function walk() {
		if (ti >= tokens.length) return null;
		let t = tokens[ti++];
		if (t === '(') {
			let list = [];
			while (ti < tokens.length && tokens[ti] !== ')') list.push(walk());
			ti++; return list;
		}
		if (t.startsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"');
		return t;
	}

	const ast =[];
	while (ti < tokens.length) ast.push(walk());
	return ast;
}

// ── Extractors ──────────────────────────────────────────────────
function extractSymbolData(node) {
	const rawName = node[1] || '';
	const name = rawName.includes(':') ? rawName.split(':').pop() : rawName;
	const props = {}, pins =[], graphics =[];
	let extendsName = null;

	for (let i = 2; i < node.length; i++) {
		const child = node[i];
		if (!Array.isArray(child)) continue;

		const tag = child[0];
		if (tag === 'extends') {
			extendsName = child[1];
		} else if (tag === 'property') {
			props[child[1]] = child[2] || '';
		} else if (tag === 'pin') {
			const at = child.find(x => Array.isArray(x) && x[0] === 'at');
			const lengthNode = child.find(x => Array.isArray(x) && x[0] === 'length');
			const nameNode = child.find(x => Array.isArray(x) && x[0] === 'name');
			const numNode = child.find(x => Array.isArray(x) && x[0] === 'number');
			if (at && numNode) {
				pins.push({
					num: numNode[1],
					name: nameNode ? nameNode[1] : '',
					x: parseFloat(at[1]) * SCALE,
					y: -parseFloat(at[2]) * SCALE,
					angle: parseFloat(at[3] || 0),
					len: lengthNode ? parseFloat(lengthNode[1]) * SCALE : 20,
					electrical_type: typeof child[1] === 'string' ? child[1] : 'passive',
					graphical_style: typeof child[2] === 'string' ? child[2] : 'line'
				});
			}
		} else if (tag === 'symbol') {
			const nested = extractSymbolData(child);
			graphics.push(...nested.graphics);
			pins.push(...nested.pins);
		} else if (['polyline', 'rectangle', 'circle', 'arc'].includes(tag)) {
			graphics.push(child);
		}
	}
	return { name, extendsName, props, pins, graphics };
}

function extractTopLevelSymbols(ast, parsedSymbols) {
	const findSymbols = (node) => {
		if (!Array.isArray(node)) return;
		if (node[0] === 'symbol') {
			const data = extractSymbolData(node);
			parsedSymbols[data.name] = data;
		} else {
			for (let i = 0; i < node.length; i++) findSymbols(node[i]);
		}
	};
	findSymbols(ast);
}

function resolveInheritance(parsedSymbols) {
	const resolve = (sym) => {
		if (!sym.extendsName) return;
		const parentName = sym.extendsName.includes(':') ? sym.extendsName.split(':').pop() : sym.extendsName;
		const parent = parsedSymbols[parentName];
		if (parent) {
			if (parent.extendsName) resolve(parent);
			sym.pins =[...parent.pins, ...sym.pins];
			sym.graphics = [...parent.graphics, ...sym.graphics];
			sym.props = { ...parent.props, ...sym.props };
		}
		sym.extendsName = null;
	};
	Object.values(parsedSymbols).forEach(sym => resolve(sym));
}

async function upsertParsedSymbols(parsedSymbols, libName) {
	const existingLib = await db.getKicadSymbols(libName) ||[];
	const existingMap = {};
	existingLib.forEach(s => existingMap[s.symbol] = s);

	let inserted = 0, updated = 0;

	const dbRecords = Object.values(parsedSymbols).map(sym => {
		const existing = existingMap[sym.name];
		if (existing) updated++; else inserted++;

		return {
			id: existing ? existing.id : uuid(), // Keep original ID if it exists
			library: libName,
			symbol: sym.name,
			reference: sym.props['Reference'] || '',
			description: sym.props['Description'] || '',
			datasheet: sym.props['Datasheet'] || '',
			keywords: sym.props['ki_keywords'] || '',
			fp_filters: sym.props['ki_fp_filters'] || '',
			footprint: sym.props['Footprint'] || '',
			pinCount: sym.pins.length,
			parsedData: JSON.stringify({ pins: sym.pins, graphics: sym.graphics, props: sym.props })
		};
	});
	if (dbRecords.length > 0) await db.saveKicadSymbolsBatch(dbRecords);
	return { inserted, updated };
}

// ── Public Importers ──────────────────────────────────────────────

export async function importSelectedFromZip({ reader, entries }, filenames, onProgress) {
	const notify = (msg) => { if (onProgress) onProgress(msg); };
	const { TextWriter } = zip;
	const entryMap = new Map(entries.map(e => [e.filename, e]));
	const total = filenames.length;

	notify(`Decompressing 0/${total} files…`);

	// Phase 1: decompression
	let done = 0;
	zip.configure({ /*useWebWorkers: false, */ useCompressionStream: true });
	// console.time('[kicad] decompress');
	const results = await Promise.all(
		filenames.map(async filename => {
			const entry = entryMap.get(filename);
			if (!entry) return null;
			const text = await entry.getData(new TextWriter());
			notify(`Decompressing ${++done}/${total} files…`);
			return { filename, text };
		})
	);
	// console.timeEnd('[kicad] decompress');

	// Phase 2: parsing
	notify(`Parsing symbols…`);
	// console.time('[kicad] parse');
	const textsByLib = {};
	for (const result of results) {
		if (!result) continue;
		const match = result.filename.match(/([^\/]+)\.kicad_symdir\//);
		const libName = match ? match[1] : 'Imported';
		if (!textsByLib[libName]) textsByLib[libName] = [];
		textsByLib[libName].push(result.text);
	}
	const parsedByLib = {};
	let totalSyms = 0;
	for (const [libName, fileTexts] of Object.entries(textsByLib)) {
		const parsedSymbols = {};
		for (const text of fileTexts) extractTopLevelSymbols(parseSexpr(text), parsedSymbols);
		resolveInheritance(parsedSymbols);
		parsedByLib[libName] = parsedSymbols;
		totalSyms += Object.keys(parsedSymbols).length;
	}
	// console.timeEnd('[kicad] parse');

	// Phase 3: DB writes
	notify(`Writing ${totalSyms} symbols to database…`);
	// console.time('[kicad] db-write');
	let stats = { inserted: 0, updated: 0 };
	const libs = Object.entries(parsedByLib);
	for (let i = 0; i < libs.length; i++) {
		const [libName, parsedSymbols] = libs[i];
		notify(`Writing ${libName} (${i + 1}/${libs.length} libraries)…`);
		const res = await upsertParsedSymbols(parsedSymbols, libName);
		stats.inserted += res.inserted;
		stats.updated += res.updated;
	}
	// console.timeEnd('[kicad] db-write');

	await reader.close();
	return stats;
}

export async function importSymbolsFromText(text, libName = 'Imported') {
	const parsedSymbols = {};
	extractTopLevelSymbols(parseSexpr(text), parsedSymbols);
	resolveInheritance(parsedSymbols);
	return await upsertParsedSymbols(parsedSymbols, libName);
}

// ── Auto-Importer for initial boot ─────────────────────────────────
export async function autoImportDeviceLib() {
	try {
		const existing = await db.getKicadSymbols('Device');
		if (existing && existing.length > 0) return;

		console.log('[kicad] Auto-importing default Device library...');
		const res = await fetch(ZIP_URL);
		if (!res.ok) throw new Error('Failed to fetch zip');

		const { ZipReader, Uint8ArrayReader, TextWriter } = zip;
		const buffer = new Uint8Array(await res.arrayBuffer());
		const reader = new ZipReader(new Uint8ArrayReader(buffer), {
			// useWebWorkers: false,
			useCompressionStream: true
		});
		const entries = await reader.getEntries();

		const parsedSymbols = {};
		for (const entry of entries) {
			if (!entry.directory
				&& entry.filename.includes('/Device.kicad_symdir/')
				&& entry.filename.endsWith('.kicad_sym')) {
				const text = await entry.getData(new TextWriter());
				extractTopLevelSymbols(parseSexpr(text), parsedSymbols);
			}
		}

		await reader.close();
		resolveInheritance(parsedSymbols);
		await upsertParsedSymbols(parsedSymbols, 'Device');
		console.log('[kicad] Default library import complete!');
	} catch (err) {
		console.error('[kicad] Auto-import failed:', err);
	}
}
