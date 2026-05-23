// ── Exports ───────────────────────────────────────────────────
import { S } from './state.js';
import { createComp } from './components.js';
import { db, uuid } from './db.js';

function toSexpr(node) {
	if (Array.isArray(node)) {
		return '(' + node.map(toSexpr).join(' ') + ')';
	}
	if (typeof node === 'string') {
		if (node === '' || /[^\w\-.]/.test(node)) return `"${node.replace(/"/g, '\\"')}"`;
		return node;
	}
	return String(node);
}

export async function getExportFilename(ext) {
	const bId = window._boardId || new URLSearchParams(window.location.search).get('boardId');
	const dId = window._deviceId || new URLSearchParams(window.location.search).get('deviceId');

	let dName = "Device";
	let bName = "Board";

	try {
		if (bId) {
			const board = await db.getBoard(bId);
			if (board && board.name) bName = board.name.replace(/[^a-z0-9_\-]/gi, '_');
			const fetchedDevId = dId || (board ? board.deviceId : null);
			if (fetchedDevId) {
				const device = await db.getDevice(fetchedDevId);
				if (device && device.name) dName = device.name.replace(/[^a-z0-9_\-]/gi, '_');
			}
		}
	} catch(e) { console.warn("Failed to fetch filename info", e); }

	return `${dName}-${bName}.${ext}`;
}

// ── KiCad Schematic (.kicad_sch) ──────────────────────────────
export async function exportKiCad() {
	const K_SCALE = 0.127; // 20px = 2.54mm -> 1px = 0.127mm
	const K_OFFSET_X = 148.5; // Center of A4 paper horizontally
	const K_OFFSET_Y = 105.0; // Center of A4 paper vertically

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	S.components.forEach(c => {
		minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
		minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
	});
	if (minX === Infinity) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
	const centerOffX = (minX + maxX) / 2;
	const centerOffY = (minY + maxY) / 2;

	const sheetUuid = uuid();

	const bId = window._boardId || new URLSearchParams(window.location.search).get('boardId');
	const dId = window._deviceId || new URLSearchParams(window.location.search).get('deviceId');

	let title = "SchemaReTrace Export";
	let comment1 = "Reverse-engineered using PCB ReTrace (pcb.etaras.com)";

	try {
		if (bId) {
			const board = await db.getBoard(bId);
			if (board && board.name) title = board.name;
			const fetchedDevId = dId || (board ? board.deviceId : null);
			if (fetchedDevId) {
				const device = await db.getDevice(fetchedDevId);
				if (device && device.name) title = device.name + " - " + board.name;
			}
		}
	} catch(e) {}

	const dateStr = new Date().toISOString().split('T')[0];

	let o = `(kicad_sch (version 20231120) (generator SchemaReTrace)\n`;
	o += `	(uuid "${sheetUuid}")\n	 (paper "A4")\n`;

	o += `	(title_block\n`;
	o += `	  (title "${title}")\n`;
	o += `	  (date "${dateStr}")\n`;
	o += `	  (comment 1 "${comment1}")\n`;
	o += `	)\n`;

	o += `	(lib_symbols\n`;

	const getKiCadLibData = async (c) => {
		if (c.componentTypeId) {
			const kSym = await db.getResolvedKicadDataForComponentType(c.componentTypeId);
			if (kSym) {
				const parsed = JSON.parse(kSym.parsedData);
				return {
					libId: `${kSym.library}:${kSym.symbol}`,
					symName: kSym.symbol,
					graphics: parsed.graphics,
					pins: parsed.pins,
					props: parsed.props || {},
					footprint: kSym.footprint || "",
					datasheet: kSym.datasheet || "~"
				};
			}
		}
		if (c.kicadData) {
			return {
				libId: `${c.kicadData.library || 'Device'}:${c.kicadData.name}`,
				symName: c.kicadData.name,
				graphics: c.kicadData.graphics,
				pins: c.kicadData.pins,
				props: c.kicadData.props || {},
				footprint: c.kicadData.footprint || "",
				datasheet: c.kicadData.datasheet || "~"
			};
		}
		let symName = 'Unknown';
		let libId = 'Device:Unknown';
		switch(c.type) {
			case 'R': libId = 'Device:R'; symName = 'R'; break;
			case 'C': libId = 'Device:C'; symName = 'C'; break;
			case 'L': libId = 'Device:L'; symName = 'L'; break;
			case 'D': libId = 'Device:D'; symName = 'D'; break;
			case 'Z': libId = 'Device:D_Zener'; symName = 'D_Zener'; break;
			default:
				if (c.ref.startsWith('Q')) { libId = 'Device:Q_NPN_BCE'; symName = 'Q_NPN_BCE'; }
				else if (c.ref.startsWith('J')) { libId = 'Device:Q_NJFET_DGS'; symName = 'Q_NJFET_DGS'; }
				else { symName = createComp(c).label || 'Unknown'; libId = `Device:${symName}`; }
		}
		return { libId, symName, graphics: null, pins: null, props: {}, footprint: "", datasheet: "~" };
	};

	const usedLibs = new Map();
	const compLibMap = new Map();

	for (const c of S.components) {
		const libData = await getKiCadLibData(c);
		compLibMap.set(c.id, libData);

		if (usedLibs.has(libData.libId)) continue;

		let refPrefix = c.ref.match(/^[A-Za-z]+/)?.[0] || 'U';
		const pfx = refPrefix.toUpperCase();
		const isPassiveOrTransistor =['R', 'C', 'L', 'D', 'Z', 'Q', 'J', 'LED'].includes(pfx) ||['R', 'C', 'L', 'D', 'Z'].includes(pfx.charAt(0));
		const hidePinsStr = isPassiveOrTransistor ? ` (pin_numbers hide) (pin_names hide)` : '';

		let symDef = `	  (symbol "${libData.libId}" (in_bom yes) (on_board yes)${hidePinsStr}\n`;

		// Map dynamically extracted library properties
		let propId = 0;
		const symProps = {
			"Reference": refPrefix,
			"Value": libData.symName,
			"Footprint": libData.footprint || "",
			"Datasheet": libData.datasheet || "~",
			...(libData.props || {})
		};['Reference', 'Value', 'Footprint', 'Datasheet'].forEach(k => {
			let hideStr = (k === 'Reference' || k === 'Value') ? '' : ' hide';
			symDef += `		 (property "${k}" "${String(symProps[k] || '').replace(/"/g, '\\"')}" (id ${propId++}) (at 0 0 0) (effects (font (size 1.27 1.27))${hideStr}))\n`;
			delete symProps[k];
		});

		for (const [k, v] of Object.entries(symProps)) {
			symDef += `		 (property "${k}" "${String(v).replace(/"/g, '\\"')}" (id ${propId++}) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))\n`;
		}

		if (libData.graphics && libData.pins) {
			symDef += `		 (symbol "${libData.symName}_0_1"\n`;
			libData.graphics.forEach(g => {
				symDef += `		   ${toSexpr(g)}\n`;
			});
			symDef += `		 )\n`;

			symDef += `		 (symbol "${libData.symName}_1_1"\n`;
			libData.pins.forEach(p => {
				const px = p.x * K_SCALE;
				const py = -p.y * K_SCALE;
				const plen = (p.len || 20) * K_SCALE;
				// Output the exact electrical type and style parsed from the DB
				const eType = p.electrical_type || 'passive';
				const gStyle = p.graphical_style || 'line';
				symDef += `		   (pin ${eType} ${gStyle} (at ${px.toFixed(3)} ${py.toFixed(3)} ${p.angle || 0}) (length ${plen.toFixed(3)})\n`;
				symDef += `			 (name "${p.name}" (effects (font (size 1.27 1.27))))\n`;
				symDef += `			 (number "${p.num}" (effects (font (size 1.27 1.27))))\n`;
				symDef += `		   )\n`;
			});
			symDef += `		 )\n`;
		} else {
			const compInst = createComp(c);
			const geo = compInst.geometry();
			const hw = (geo.w / 2) * K_SCALE;
			const hh = (geo.h / 2) * K_SCALE;

			symDef += `		 (symbol "${libData.symName}_0_1"\n`;
			symDef += `		   (rectangle (start -${hw.toFixed(3)} -${hh.toFixed(3)}) (end ${hw.toFixed(3)} ${hh.toFixed(3)})\n`;
			symDef += `			 (stroke (width 0.254) (type default)) (fill (type background))\n		 )\n	  )\n`;
			symDef += `		 (symbol "${libData.symName}_1_1"\n`;
			compInst._pinLocalCoords().forEach((pinCoord, i) => {
				const px = pinCoord.ldx * K_SCALE;
				const py = -pinCoord.ldy * K_SCALE;
				const stubLen = compInst.stubLen(i) * K_SCALE;
				const connX = px + (pinCoord.ex * stubLen);
				const connY = py + (-pinCoord.ey * stubLen);

				let kAngle = 0;
				if (pinCoord.ex > 0.5) kAngle = 180;
				else if (pinCoord.ex < -0.5) kAngle = 0;
				else if (pinCoord.ey < -0.5) kAngle = 270;
				else if (pinCoord.ey > 0.5) kAngle = 90;

				const num = pinCoord.gp.name || String(i + 1);
				symDef += `		   (pin passive line (at ${connX.toFixed(3)} ${connY.toFixed(3)} ${kAngle}) (length ${stubLen.toFixed(3)})\n`;
				symDef += `			 (name "${num}" (effects (font (size 1.27 1.27))))\n`;
				symDef += `			 (number "${num}" (effects (font (size 1.27 1.27))))\n		  )\n`;
			});
			symDef += `		 )\n`;
		}
		symDef += `	   )\n`;
		usedLibs.set(libData.libId, symDef);
	}

	usedLibs.forEach(def => { o += def; });
	o += `	)\n`;

	// Component Instantiation on the Paper
	S.components.forEach(c => {
		const libData = compLibMap.get(c.id);
		const cx = (c.x - centerOffX) * K_SCALE + K_OFFSET_X;
		const cy = (c.y - centerOffY) * K_SCALE + K_OFFSET_Y;

		let rot = (-c.rotation || 0) % 360;
		if (rot < 0) rot += 360;
		let mirrorStr = c.flipX ? " (mirror y)" : "";

		let textAngle = (rot === 90 || rot === 270) ? 90 : 0;

		const hasValue = !!c.value;
		const val = c.value || libData.symName;
		const valHide = hasValue ? "" : " hide";
		const compUuid = uuid();

		let refX = cx + 2, refY = cy - 2;
		let valX = cx + 2, valY = cy + 2;

		if (S.componentLabels && S.componentLabels[c.id]) {
			const hint = S.componentLabels[c.id];
			refX = (hint.refPosition.x - centerOffX) * K_SCALE + K_OFFSET_X;
			refY = (hint.refPosition.y - centerOffY) * K_SCALE + K_OFFSET_Y;

			valX = (hint.valuePosition.x - centerOffX) * K_SCALE + K_OFFSET_X;
			valY = (hint.valuePosition.y - centerOffY) * K_SCALE + K_OFFSET_Y;
		}

		o += `	(symbol (lib_id "${libData.libId}") (at ${cx.toFixed(3)} ${cy.toFixed(3)} ${rot})${mirrorStr} (unit 1)\n`;
		o += `	  (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced no) (uuid "${compUuid}")\n`;

		// Write all dynamic instance properties
		let propId = 0;
		const instProps = {
			"Reference": c.ref,
			"Value": val,
			"Footprint": libData.footprint || "",
			"Datasheet": libData.datasheet || "~",
			...(libData.props || {})
		};['Reference', 'Value', 'Footprint', 'Datasheet'].forEach(k => {
			let pX = cx, pY = cy;
			if (k === 'Reference') { pX = refX; pY = refY; }
			else if (k === 'Value') { pX = valX; pY = valY; }

			let hideStr = (k === 'Footprint' || k === 'Datasheet' || (k === 'Value' && valHide)) ? ' hide' : '';
			o += `	  (property "${k}" "${String(instProps[k] || '').replace(/"/g, '\\"')}" (id ${propId++}) (at ${pX.toFixed(3)} ${pY.toFixed(3)} ${textAngle})\n`;
			o += `		(effects (font (size 1.27 1.27))${hideStr})\n	 )\n`;
			delete instProps[k];
		});

		for (const [k, v] of Object.entries(instProps)) {
			if (!k.startsWith('ki_')) {
				o += `	  (property "${k}" "${String(v).replace(/"/g, '\\"')}" (id ${propId++}) (at ${cx.toFixed(3)} ${cy.toFixed(3)} ${textAngle})\n`;
				o += `		(effects (font (size 1.27 1.27)) hide)\n	)\n`;
			}
		}

		o += `	  (instances\n`;
		o += `		(project ""\n`;
		o += `		  (path "/${sheetUuid}"\n`;
		o += `			(reference "${c.ref}") (unit 1)\n`;
		o += `		  )\n`;
		o += `		)\n`;
		o += `	  )\n`;

		o += `	)\n`;
	});

	S.wires.forEach(w => {
		if (!w.points || w.points.length < 2) return;
		for (let i = 0; i < w.points.length - 1; i++) {
			const p1 = w.points[i];
			const p2 = w.points[i+1];
			const x1 = (p1.x - centerOffX) * K_SCALE + K_OFFSET_X;
			const y1 = (p1.y - centerOffY) * K_SCALE + K_OFFSET_Y;
			const x2 = (p2.x - centerOffX) * K_SCALE + K_OFFSET_X;
			const y2 = (p2.y - centerOffY) * K_SCALE + K_OFFSET_Y;
			o += `	(wire (pts (xy ${x1.toFixed(3)} ${y1.toFixed(3)}) (xy ${x2.toFixed(3)} ${y2.toFixed(3)}))\n`;
			o += `	  (stroke (width 0) (type default)) (uuid "${uuid()}")\n  )\n`;
		}
	});

	if (S.junctionPoints) {
		S.junctionPoints.forEach(j => {
			const jx = (j.x - centerOffX) * K_SCALE + K_OFFSET_X;
			const jy = (j.y - centerOffY) * K_SCALE + K_OFFSET_Y;
			o += `	(junction (at ${jx.toFixed(3)} ${jy.toFixed(3)}) (diameter 0) (color 0 0 0 0) (uuid "${uuid()}"))\n`;
		});
	}

	o += `)\n`;
	return o;
}

// ── MicroCAP Schematic (.cir) ─────────────────────────────────
export function exportSpice() {
	const M_SCALE = 8 / 20; // Scale our 20px grid to an 8-unit MicroCap schematic grid
	const M_OFFSET = 200; // Center offset for MicroCap

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	S.components.forEach(c => {
		minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
		minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
	});
	if (minX === Infinity) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
	const centerOffX = (minX + maxX) / 2;
	const centerOffY = (minY + maxY) / 2;

	let o = `[Main]\nFileType=CIR\nVersion=12.00\nProgram=Micro-Cap\n\n`;

	const getMcName = (type) => {
		switch(type) {
			case 'R': return 'Resistor';
			case 'C': return 'Capacitor';
			case 'L': return 'Inductor';
			case 'D': return 'Diode';
			case 'Z': return 'Zener';
			default: return 'Macro';
		}
	};

	S.components.forEach(c => {
		const mcName = getMcName(c.type);
		const cx = Math.round((c.x - centerOffX) * M_SCALE) + M_OFFSET;
		const cy = Math.round((c.y - centerOffY) * M_SCALE) + M_OFFSET;

		let rot = Math.round((c.rotation || 0) / 90) % 4;
		if (rot < 0) rot += 4;
		if (c.flipX) rot += 4;

		o += `[Comp]\nName=${mcName}\nPx=${cx},${cy}\nRot=${rot}\n`;
		o += `[Attr]\nON=10,-10,PART\nV=${c.ref}\n`;
		o += `[Attr]\nON=10,10,VALUE\nV=${c.value || '1k'}\n\n`;
	});

	S.wires.forEach(w => {
		if (!w.points || w.points.length < 2) return;
		for (let i = 0; i < w.points.length - 1; i++) {
			const p1 = w.points[i];
			const p2 = w.points[i+1];
			const x1 = Math.round((p1.x - centerOffX) * M_SCALE) + M_OFFSET;
			const y1 = Math.round((p1.y - centerOffY) * M_SCALE) + M_OFFSET;
			const x2 = Math.round((p2.x - centerOffX) * M_SCALE) + M_OFFSET;
			const y2 = Math.round((p2.y - centerOffY) * M_SCALE) + M_OFFSET;
			o += `[Wire]\nPxs=${x1},${y1},${x2},${y2}\n\n`;
		}
	});

	return o;
}

// ── postMessage listener ──────────────────────────────────────
let _loadBoard = null;

export function setIOCallbacks(loadBoard) {
	_loadBoard = loadBoard;
}

export function initPostMessageListener() {
	window.addEventListener('message', e => {
		// console.log('[schema/io] message received:', e.data?.type, e.origin);
		const d = e.data;
		if (!d || typeof d !== 'object') return;
		if (d.type === 'SCHEMA_INIT') {
				window._embeddedMode = true;

				// Safely cache data for title block exports
				window._boardId = d.boardId || null;
				window._deviceId = d.deviceId || null;

				const elementsToHide =['btn-load-db', 'btn-import-file', 'es-load-btn'];
				elementsToHide.forEach(id => {
						const el = document.getElementById(id);
						if (el) el.style.display = 'none';
				});
				window.parent.postMessage({ type: 'SCHEMA_READY' }, '*');
				if (_loadBoard) _loadBoard(d.boardId || null, d.deviceId || null);
		} else if (d.type === 'SCHEMA_RESIZE') {
				import('./app.js').then(({ triggerResize }) => triggerResize());
		}
	});
}
