// ── Parsers ───────────────────────────────────────────────────
import { classifyComp } from './components.js';

// ── Studio DB → internal format ───────────────────────────────
// Translates Studio's component and net records into the internal
// parsed format that loadNetlist() consumes.
//
// Studio component shape:	{ id, boardId, label, value, desc, x?, y?, imgId? }
// Studio net node shape:		{ label: "R1.2" } (ref.pin) or { label: "TP1" } (ref only)
//
// Internal format:
//	 components: [{ ref, value, type, studioId }]
//	 nets:			 [{ name, nodes:[{ ref, pin }] }]
export function parseFromStudioDB(studioComponents, studioNets) {
	const components = studioComponents.map(c => ({
		ref:			c.label,
		value:		c.value || '',
		type:			classifyComp(c.label),
		studioId: c.id,			// preserved so app.js can link back to schemaComponents
	}));

	const nets = studioNets.map(n => ({
		name:	 n.name,
		nodes: (n.nodes || []).map(nd => {
			const parts = (nd.label || '').split('.');
			if (parts.length >= 2) {
				return { ref: parts[0], pin: parts[1] };
			}
			// Single-label node (e.g. test point) — default to pin 1
			return { ref: nd.label || '', pin: '1' };
		}).filter(nd => nd.ref),
	}));

	return { components, nets };
}

// ── PCB ReTrace JSON ──────────────────────────────────────────
export function parseJsonNetlist(json) {
	if (json.nets && json.components) {
		return {
			components: json.components.map(c => ({
				ref: c.ref, value: c.value || '',
				type: c.type || classifyComp(c.ref),
			})),
			nets: json.nets.map(n => ({ name: n.name, nodes: n.nodes || [] })),
		};
	}
	if (Array.isArray(json)) {
		const refs = new Set();
		json.forEach(n => (n.nodes || []).forEach(nd => refs.add(nd.ref)));
		return {
			components: [...refs].map(r => ({ ref: r, value: '', type: classifyComp(r) })),
			nets: json,
		};
	}
	throw new Error('Unknown JSON format');
}

// ── KiCad XML netlist ─────────────────────────────────────────
export function parseKiCadXml(text) {
	const doc		= new DOMParser().parseFromString(text, 'text/xml');
	const comps = [];
	doc.querySelectorAll('comp').forEach(el =>
		comps.push({
			ref:	 el.getAttribute('ref'),
			value: el.querySelector('value')?.textContent || '',
			type:	 classifyComp(el.getAttribute('ref')),
		})
	);
	const nets = [];
	doc.querySelectorAll('net').forEach(el => {
		const nodes = [];
		el.querySelectorAll('node').forEach(n =>
			nodes.push({ ref: n.getAttribute('ref'), pin: n.getAttribute('pin') || '1' })
		);
		nets.push({ name: el.getAttribute('name') || 'NET', nodes });
	});
	return { components: comps, nets };
}

// ── KiCad S-expression netlist ────────────────────────────────
export function parseKiCadSexpr(text) {
	const comps = [], nets =[];
	let m;
	const cR = /\(comp\s+\(ref\s+"?([^"\s)]+)"?\)[\s\S]*?\(value\s+"?([^"\s)]*)"?\)/g;
	while ((m = cR.exec(text)) !== null)
		comps.push({ ref: m[1], value: m[2], type: classifyComp(m[1]) });

	// Split text by "(net " to robustly isolate each net block regardless of nesting
	const netBlocks = text.split(/\(\s*net\s+/).slice(1);
	netBlocks.forEach(block => {
		const nameMatch = block.match(/\(name\s+"?([^"\s)]*)"?\)/);
		if (!nameMatch) return;

		const nodes = [];
		const ndR = /\(node\s+\(ref\s+"?([^"\s)]+)"?\)\s+\(pin\s+"?([^"\s)]+)"?/g;
		let nm;
		while ((nm = ndR.exec(block)) !== null) nodes.push({ ref: nm[1], pin: nm[2] });

		nets.push({ name: nameMatch[1], nodes });
	});
	return { components: comps, nets };
}

// ── SPICE netlist (.cir) ──────────────────────────────────────
export function parseSpice(text) {
	const comps =[], netsMap = {};
	const lines = text.split('\n');
	lines.forEach(line => {
		let l = line.trim();
		if (!l || l.startsWith('.') || l.startsWith('*') || l.startsWith('+')) return;
		const tokens = l.split(/\s+/);
		if (tokens.length < 3) return;
		const ref = tokens[0];
		const value = tokens[tokens.length - 1];
		comps.push({ ref, value, type: classifyComp(ref) });

		// Pins are ordered sequentially between Ref and Value
		for (let i = 1; i < tokens.length - 1; i++) {
			const netName = tokens[i];
			if (!netsMap[netName]) netsMap[netName] = [];
			netsMap[netName].push({ ref, pin: String(i) });
		}
	});
	const nets = Object.keys(netsMap).map(name => ({ name, nodes: netsMap[name] }));
	return { components: comps, nets };
}

// ── Detect and dispatch file content ─────────────────────────
export function parseFileContent(text) {
	const t = text.trim();
	if (t.startsWith('{') || t.startsWith('['))
		return parseJsonNetlist(JSON.parse(t));
	if (t.startsWith('*') || t.startsWith('.title') || t.includes('.end'))
		return parseSpice(t);
	if (t.includes('(export') || t.includes('(net '))
		return parseKiCadSexpr(t);
	return parseKiCadXml(t);
}
