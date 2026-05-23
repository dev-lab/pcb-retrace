/* nets.js - Netlist Management (v3) */

class NetManager {
	constructor(db) {
		this.db = db;
		this.showOnlyProblematic = false; // Toggle state
	}

	// Updates the global toolbar button state
	updateTopBar(problemCount) {
		const bar = document.querySelector('#view-nets .actions-bar');
		if (!bar) return;
		let fixBtn = document.getElementById('net-fix-btn');
		if (!fixBtn) {
			fixBtn = document.createElement('button');
			fixBtn.id = 'net-fix-btn';
			fixBtn.onclick = () => this.toggleFixMode();
			bar.appendChild(fixBtn);
		}

		if (problemCount === 0) {
			fixBtn.className = 'secondary';
			fixBtn.innerHTML = '✅ All Valid';
			fixBtn.disabled = true;
			fixBtn.style.opacity = '0.7';
			this.showOnlyProblematic = false; // Auto-reset if everything is fixed
		} else {
			fixBtn.disabled = false;
			fixBtn.style.opacity = '1';
			if (this.showOnlyProblematic) {
				fixBtn.className = 'primary'; // Active/Pressed state
				fixBtn.innerHTML = `Showing ${problemCount} Issues (Click to Reset)`;
			} else {
				fixBtn.className = 'danger'; // Needs attention state
				fixBtn.innerHTML = `⚠️ ${problemCount} Issues Found`;
			}
		}
	}

	// Toggles the filter and checks for empty nets
	async toggleFixMode() {
		if (this.showOnlyProblematic) {
			this.showOnlyProblematic = false;
			this.render();
			return;
		}

		// Turning ON: Check for empty nets first
		const allNets = await this.db.getNets();
		const nets = allNets.filter(n => n.projectId === currentBomId);
		const emptyNets = nets.filter(n => !n.nodes || n.nodes.length === 0);

		if (emptyNets.length > 0) {
			if (await confirmAction(`Found ${emptyNets.length} empty net(s).\n\nDelete them to clean up?`, "Delete Empty Nets")) {
				for (const n of emptyNets) {
					await this.db.deleteNet(n.id);
				}
			}
		}

		this.showOnlyProblematic = true;
		this.render();
	}

	// Conflict Resolution Logic
	async resolveNet(netId) {
		const allNets = await this.db.getNets();
		const projectNets = allNets.filter(n => n.projectId === currentBomId);
		const net = projectNets.find(n => n.id === netId);
		if (!net) return;

		// 1. Handle Empty Nets
		if (!net.nodes || net.nodes.length === 0) {
			if (await confirmAction(`This net is completely empty.\n\nDelete it?`, "Delete")) {
				await this.db.deleteNet(net.id);
				this.render();
			}
			return;
		}

		// Rebuild mapping locally to find exact duplicates
		const nodeMap = {};
		projectNets.forEach(n => {
			if(!n.nodes) return;
			n.nodes.forEach(node => {
				if (!nodeMap[node.label]) nodeMap[node.label] = [];
				nodeMap[node.label].push(n);
			});
		});

		// 2. Check for formatting errors first
		const formatErrIdx = net.nodes.findIndex(n => !/^[A-Za-z0-9_-]+\.[1-9][0-9]*$/.test(n.label));
		if (formatErrIdx > -1) {
			const node = net.nodes[formatErrIdx];
			alert(`Node "${node.label}" has an invalid format.\n\nPlease rename it using the "Ref.Pin" format (e.g., R1.1).`);
			return this.editNode(net.id, formatErrIdx);
		}

		// 3. Check for duplicates and build explanation matrix
		const conflicts =[];
		const otherNetsMap = new Map(); // Maps id -> net object

		net.nodes.forEach(node => {
			if (nodeMap[node.label] && nodeMap[node.label].length > 1) {
				const others = nodeMap[node.label].filter(n => n.id !== net.id);
				others.forEach(o => {
					conflicts.push(`• ${node.label} is also in ${o.name}`);
					otherNetsMap.set(o.id, o);
				});
			}
		});

		if (conflicts.length > 0) {
			const otherNets = Array.from(otherNetsMap.values());
			// Pick the first conflicting net as the target for merging
			const targetNet = otherNets[0];

			let msg = `Conflict: Nodes in this net exist elsewhere:\n${conflicts.join('\n')}\n\n`;
			msg += `Would you like to merge all nodes from ${net.name} into ${targetNet.name} and delete ${net.name}?\n\n`;
			msg += `(Click "Cancel" to close this dialog and rename/fix the nodes manually)`;

			// confirmAction already sets focus to the Cancel button by default
			const doMerge = await confirmAction(msg, `Merge into ${targetNet.name}`);

			if (doMerge) {
				// SAFETY CHECK: Warn if merging a larger net into a smaller one
				if (net.nodes.length > targetNet.nodes.length) {
					const warnMsg = `WARNING: You are merging a larger net (${net.nodes.length} nodes) into a smaller net (${targetNet.nodes.length} nodes).\n\nAre you sure you want to completely merge ${net.name} into ${targetNet.name}?`;
					const sure = await confirmAction(warnMsg, "Yes, Merge Anyway");
					if (!sure) return;
				}

				// Perform Merge (add all nodes, skipping exact label duplicates)
				const targetLabels = new Set(targetNet.nodes.map(n => n.label));
				for (const n of net.nodes) {
					if (!targetLabels.has(n.label)) {
						targetNet.nodes.push(n);
						targetLabels.add(n.label);
					}
				}
				await this.db.addNet(targetNet);
				await this.db.deleteNet(net.id);
				this.render();
			}
		}
	}

	async render() {
		const tbody = document.getElementById('nets-body');
		if(!tbody) return;

		// Safety check
		if (typeof currentBomId === 'undefined' || !currentBomId) {
			 tbody.innerHTML = '';
			 return;
		}

		tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#888;">Loading...</td></tr>';

		const allNets = await this.db.getNets();
		const nets = allNets.filter(n => n.projectId === currentBomId);

		// --- NEW: Pre-calculate errors ---
		const nodeMap = {}; // label -> array of netIds
		let totalProblems = 0;

		nets.forEach(net => {
			if (!net.nodes || net.nodes.length === 0) {
				net._hasError = true;
				net._isEmpty = true;
			} else {
				net.nodes.forEach(node => {
					if (!nodeMap[node.label]) nodeMap[node.label] =[];
					nodeMap[node.label].push(net.id);
				});
			}
		});

		nets.forEach(net => {
			let netHasError = net._isEmpty || false;
			if (net.nodes) {
				net.nodes.forEach(node => {
					node._isFormatInvalid = !/^[A-Za-z0-9_-]+\.[1-9][0-9]*$/.test(node.label);
					node._isDuplicate = nodeMap[node.label] && nodeMap[node.label].length > 1;
					if (node._isFormatInvalid || node._isDuplicate) {
						node._hasError = true;
						netHasError = true;
					}
				});
			}
			net._hasError = netHasError;
			if (netHasError) totalProblems++;
		});

		// Update toolbar toggle
		this.updateTopBar(totalProblems);

		tbody.innerHTML = '';

		if(nets.length === 0) {
			tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:2rem; color:#94a3b8;">No nets defined. Go to "Inspect" to create one.</td></tr>';
			return;
		}

		let renderedCount = 0;

		nets.forEach(net => {
			// Filter check
			if (this.showOnlyProblematic && !net._hasError) return;

			renderedCount++;
			const tr = document.createElement('tr');
			tr.style.height = 'auto';
			tr.style.minHeight = '2.2rem';

			const targetIcon = `<span style="cursor:pointer; margin-right:0.5rem;" onclick="netManager.editNet('${net.id}')" title="Edit Net on Board">🎯</span>`;

			// NEW: Net Level Fix Button
			const fixBtn = net._hasError ? `<button class="danger sm-btn" style="padding:0 6px; margin-right:6px; font-size:0.75rem;" onclick="netManager.resolveNet('${net.id}')" title="Resolve Issues">⚠️ Fix</button>` : '';

			let nodesHtml = '';
			net.nodes.forEach((n, idx) => {
				let style = "class='net-chip'";
				let warn = "";
				// NEW: Node Level Warning Styles
				if (n._hasError) {
					style = "class='net-chip' style='border-color:#ef4444; background:#fef2f2; color:#b91c1c;'";
					warn = n._isDuplicate ? " ⚠️(Dup)" : " ❌(Fmt)";
				}
				nodesHtml += `<span ${style} onclick="netManager.editNode('${net.id}', ${idx})" title="Edit Node">${n.label}${warn}</span>`;
			});

			tr.innerHTML = `
				<td style="display:flex; align-items:center; vertical-align:top; height:auto; padding-top:6px">
					<div style="display:flex; flex-wrap:wrap; gap:4px; padding:4px 0;">
					${targetIcon}
					<input type="text" value="${net.name}" onchange="netManager.rename('${net.id}', this.value)" style="border:none; background:transparent; font-weight:bold; flex:1; min-width:0;">
					${fixBtn}
					</div>
				</td>

				<td style="white-space:normal; height:auto; overflow:visible;">
					<div style="display:flex; flex-wrap:wrap; gap:4px; padding:4px 0;">${nodesHtml}</div>
				</td>

				<td style="text-align:right; vertical-align:top; height:auto;">
					<button class="danger sm-btn" onclick="netManager.delete('${net.id}')" title="Delete Net">🗑️</button>
				</td>
			`;
			tbody.appendChild(tr);
		});

		// Empty state if filter hides everything
		if (renderedCount === 0 && this.showOnlyProblematic) {
			tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:2rem; color:#10b981;">No issues found! 🎉</td></tr>';
		}
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
			extraBtn: { label: 'Delete', value: '__DELETE__', class: 'danger' },
			helpHtml: PIN_HELP_HTML,
			validate: validateNetName,
			validateArgs: [netId]
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
			'R':	{ lib: "Device", part: "R", desc: "Resistor" },
			'C':	{ lib: "Device", part: "C", desc: "Unpolarized capacitor" },
			'L':	{ lib: "Device", part: "L", desc: "Inductor" },
			'D':	{ lib: "Device", part: "D", desc: "Diode" },
			'TP': { lib: "Connector", part: "TestPoint", desc: "Test Point" },

			// --- AMBIGUOUS TYPES (Disabled by default) ---
			// 'Q':	 { lib: "Device", part: "Q_NPN_BEC", desc: "Transistor NPN" }, // Risk: Could be PNP, MOSFET, IGBT
			// 'J':	 { lib: "Connector", part: "Conn_01x02_Male", desc: "Connector" }, // Risk: Pin count unknown
			// 'CN': { lib: "Connector", part: "Conn_01x02_Male", desc: "Connector" }, // Risk: Pin count unknown
		};

		let out = "(export (version D)\n";

		// 2. Export Components
		out += "	(components\n";
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
			out += `		(value "${val}")\n`;
			if(footprint) out += `		(footprint "${footprint}")\n`;

			// Inject Library Source if we have a safe definition
			if(def) {
				out += `		(libsource (lib "${def.lib}") (part "${def.part}") (description "${def.desc}"))\n`;
				out += `		(property (name "Sheetname") (value "")) (property (name "Sheetfile") (value "${filename}.kicad_sch"))\n`;
			}

			out += `		(tstamp "${tstamp}")\n`;
			out += `	)\n`;
		});
		out += "	)\n";

		// 3. Export Nets
		out += "	(nets\n";
		nets.forEach((net, i) => {
			out += `	(net (code ${i+1}) (name "${net.name}")\n`;
			net.nodes.forEach(node => {
				const parts = node.label.split('.');
				if(parts.length === 2) {
					// Format: R1.2 (Ref R1, Pin 2)
					out += `		(node (ref "${parts[0]}") (pin "${parts[1]}"))\n`;
				} else {
					// Fallback: TestPoints or direct names often use Pin 1
					out += `		(node (ref "${node.label}") (pin "1"))\n`;
				}
			});
			out += "	)\n";
		});
		out += "	)\n)\n";

		// 4. Download
		const blob = new Blob([out], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${filename}.net`;
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
	}

	async exportSpice() {
		let filename = "board_netlist";
		if (typeof currentBomId !== 'undefined' && typeof bomList !== 'undefined') {
			const meta = bomList.find(b => b.id === currentBomId);
			if (meta && meta.name) {
				filename = meta.name.replace(/[^a-z0-9_\-\.]/gi, '_');
			}
		}

		const nets = await this.db.getNets();
		const components = (typeof bomData !== 'undefined') ? bomData :[];

		let out = "* SPICE Netlist generated by PCB ReTrace\n";

		components.forEach(c => {
			const val = c.value ? c.value.replace(/\s+/g, '_') : "1k";
			const ref = c.label;

			const pinToNet = {};
			let maxPin = 0;
			nets.forEach(net => {
				net.nodes.forEach(node => {
					const parts = node.label.split('.');
					if (parts[0] === ref) {
						const pinNum = parseInt(parts[1]) || 1;
						pinToNet[pinNum] = net.name;
						if (pinNum > maxPin) maxPin = pinNum;
					} else if (node.label === ref) {
						pinToNet[1] = net.name;
						if (1 > maxPin) maxPin = 1;
					}
				});
			});

			let netString = "";
			const pinCount = maxPin > 0 ? maxPin : 2;
			for (let i = 1; i <= pinCount; i++) {
				netString += (pinToNet[i] || `NC_${ref}_${i}`) + " ";
			}

			out += `${ref} ${netString}${val}\n`;
		});

		out += ".end\n";

		const blob = new Blob([out], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${filename}.cir`;
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
	}
}
