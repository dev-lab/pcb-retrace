/* nets.js - Netlist Management (v2) */

class NetManager {
	constructor(db) {
		this.db = db;
	}

async render() {
		const tbody = document.getElementById('nets-body');
		if(!tbody) return;

		// Safety check: If no board is loaded, clear the table
		if (typeof currentBomId === 'undefined' || !currentBomId) {
			 tbody.innerHTML = '';
			 return;
		}

		tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#888;">Loading...</td></tr>';

		const allNets = await this.db.getNets();

		// --- FIX: Filter by Current Board ID ---
		const nets = allNets.filter(n => n.projectId === currentBomId);

		tbody.innerHTML = '';

		if(nets.length === 0) {
			tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:2rem; color:#94a3b8;">No nets defined. Go to "Inspect" to create one.</td></tr>';
			return;
		}

		nets.forEach(net => {
			const tr = document.createElement('tr');

			tr.style.height = 'auto';
			tr.style.minHeight = '2.2rem';

			// Target Icon for Editing
			const targetIcon = `<span style="cursor:pointer; margin-right:0.5rem;" onclick="netManager.editNet('${net.id}')" title="Edit Net on Board">🎯</span>`;

			let nodesHtml = '';
			net.nodes.forEach((n, idx) => {
				nodesHtml += `<span class="net-chip" onclick="netManager.editNode('${net.id}', ${idx})" title="Edit Node">${n.label}</span>`;
			});

			tr.innerHTML = `
				<td style="display:flex; align-items:center; vertical-align:top; height:auto;">
					${targetIcon}
					<input type="text" value="${net.name}" onchange="netManager.rename('${net.id}', this.value)" style="border:none; background:transparent; font-weight:bold; flex:1; min-width:0;">
				</td>

				<td style="white-space:normal; height:auto; overflow:visible;">
					<div style="display:flex; flex-wrap:wrap; gap:4px; padding:2px 0;">${nodesHtml}</div>
				</td>

				<td style="text-align:right; vertical-align:top; height:auto;">
					<button class="danger sm-btn" onclick="netManager.delete('${net.id}')" title="Delete Net">🗑️</button>
				</td>
			`;
			tbody.appendChild(tr);
		});
	}

	// Edit Net in Inspector
	async editNet(id) {
		const net = await this.db._tx('nets', 'readonly', s => s.get(id));
		if(net) {
			switchView('inspect');
			// We use the global inspector instance
			if(window.inspector) window.inspector.loadNet(net);
		}
	}

	// Edit individual node
	async editNode(netId, nodeIdx) {
		const net = await this.db._tx('nets', 'readonly', s => s.get(netId));
		if(!net || !net.nodes[nodeIdx]) return;

		const node = net.nodes[nodeIdx];

		const res = await requestInput("Edit Node", "Node Name", node.label, {
			extraBtn: { label: 'Delete', value: '__DELETE__', class: 'danger' }
		});

		if (res === '__DELETE__') {
			net.nodes.splice(nodeIdx, 1);
			await this.db.addNet(net);
			this.render();
		} else if (res) {
			net.nodes[nodeIdx].label = res;
			await this.db.addNet(net);
			this.render();
		}
	}

	async rename(id, newName) {
		if(!newName.trim()) return;
		const net = await this.db._tx('nets', 'readonly', s => s.get(id));
		if(net) {
			net.name = newName.trim();
			await this.db.addNet(net);
		}
	}

	async delete(id) {
		if(await confirmAction("Delete this net?", "Delete")) {
			await this.db.deleteNet(id);
			this.render();
		}
	}

	async exportKiCad() {
		// 1. Determine Filename
		let filename = "board_netlist";
		if (typeof currentBomId !== 'undefined' && typeof bomList !== 'undefined') {
			const meta = bomList.find(b => b.id === currentBomId);
			if (meta && meta.name) {
				filename = meta.name.replace(/[^a-z0-9_\-\.]/gi, '_');
			}
		}

		const nets = await this.db.getNets();
		const components = (typeof bomData !== 'undefined') ? bomData : [];

		// --- CONFIGURATION: Component Type Mapping ---
		// We only map types that are structurally unambiguous (2-pin passives, test points).
		// Complex types (Q, U, J) are commented out to prevent incorrect symbol assignment.
		const COMPONENT_LIBRARY_MAP = {
			'R':  { lib: "Device", part: "R", desc: "Resistor" },
			'C':  { lib: "Device", part: "C", desc: "Unpolarized capacitor" },
			'L':  { lib: "Device", part: "L", desc: "Inductor" },
			'D':  { lib: "Device", part: "D", desc: "Diode" },
			'TP': { lib: "Connector", part: "TestPoint", desc: "Test Point" },

			// --- AMBIGUOUS TYPES (Disabled by default) ---
			// 'Q':	 { lib: "Device", part: "Q_NPN_BEC", desc: "Transistor NPN" }, // Risk: Could be PNP, MOSFET, IGBT
			// 'J':	 { lib: "Connector", part: "Conn_01x02_Male", desc: "Connector" }, // Risk: Pin count unknown
			// 'CN': { lib: "Connector", part: "Conn_01x02_Male", desc: "Connector" }, // Risk: Pin count unknown
		};

		let out = "(export (version D)\n";

		// 2. Export Components
		out += "  (components\n";
		components.forEach(c => {
			const val = c.value ? c.value : "~";
			const footprint = c.desc ? c.desc.replace(/"/g, '') : "";
			const tstamp = c.id ? c.id.substring(0, 8) : Math.floor(Math.random()*10000000).toString(16);

			// Detect Type from Prefix
			const prefix = (c.label.match(/^[A-Z]+/) || [""])[0].toUpperCase();

			// Lookup Library definition
			// Future TODO: Add logic here to check c.desc for keywords like "NPN", "MOSFET", etc.
			const def = COMPONENT_LIBRARY_MAP[prefix];

			out += `	(comp (ref "${c.label}")\n`;
			out += `	  (value "${val}")\n`;
			if(footprint) out += `		(footprint "${footprint}")\n`;

			// Inject Library Source if we have a safe definition
			if(def) {
				out += `	  (libsource (lib "${def.lib}") (part "${def.part}") (description "${def.desc}"))\n`;
				out += `	  (property (name "Sheetname") (value "")) (property (name "Sheetfile") (value "${filename}.kicad_sch"))\n`;
			}

			out += `	  (tstamp "${tstamp}")\n`;
			out += `	)\n`;
		});
		out += "  )\n";

		// 3. Export Nets
		out += "  (nets\n";
		nets.forEach((net, i) => {
			out += `	(net (code ${i+1}) (name "${net.name}")\n`;
			net.nodes.forEach(node => {
				const parts = node.label.split('.');
				if(parts.length === 2) {
					// Format: R1.2 (Ref R1, Pin 2)
					out += `	  (node (ref "${parts[0]}") (pin "${parts[1]}"))\n`;
				} else {
					// Fallback: TestPoints or direct names often use Pin 1
					out += `	  (node (ref "${node.label}") (pin "1"))\n`;
				}
			});
			out += "	)\n";
		});
		out += "  )\n)\n";

		// 4. Download
		const blob = new Blob([out], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${filename}.net`;
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
	}

}
