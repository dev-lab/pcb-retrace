/*
 * Copyright (c) 2025-2026 Taras Greben
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial-pcb-retrace
 * See LICENSE file for details.
 */

// ── UI helpers ────────────────────────────────────────────────
import { db, uuid } from './db.js';
import { S, getNetColor }			  from './state.js';
import { compColor, compLabel }		  from './components.js';
import { render }					  from './draw.js';
import { pushHistory, undo }		  from './history.js';
import { fitView, routeWires }		from './layout.js';
import { importSelectedFromZip, importSymbolsFromText } from './kicad.js';

// ── Toast notification ────────────────────────────────────────
let _toastTimer;
export function toast(msg, type = '') {
	const el = document.getElementById('toast');
	el.textContent = msg;
	el.className   = 'show' + (type ? ' ' + type : '');
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => { el.className = type || ''; }, 2600);
}

// ── Status bar ────────────────────────────────────────────────
export function setStatus(msg, type = '', shortMsg = null) {
	const el = document.getElementById('status-msg');
	el.className = type;
	if (shortMsg) {
		el.setAttribute('data-long', msg);
		el.setAttribute('data-short', shortMsg);
		el.classList.add('responsive-text');
		el.textContent = '';
	} else {
		el.removeAttribute('data-long');
		el.removeAttribute('data-short');
		el.classList.remove('responsive-text');
		el.textContent = msg;
	}
}

// ── Modal helpers ─────────────────────────────────────────────
export function showModal(id) { document.getElementById(id).classList.add('active');	}
export function hideModal(id) { document.getElementById(id).classList.remove('active'); }

// ── Properties panel ─────────────────────────────────────────
export function showProperties(comp) {
	document.getElementById('right-panel')?.classList.add('open');
	const col = compColor(comp.type);

	let extraProps = '';
	if (comp.type !== 'KICAD') {
		extraProps = `
			<div class="prop-row" style="margin-top:6px; border-top:1px solid var(--border); padding-top:6px;">
				<div class="prop-label">Pin Count</div>
				<input type="number" class="prop-input" id="ppc" value="${comp.pins.length}" min="1">
			</div>
		`;
	}

	const isKicad = comp.type === 'KICAD' && comp.kicadData?.pins;
	const kPins = isKicad ? comp.kicadData.pins : new Array();

	let shiftUi = `<div class="prop-label">Pins (${comp.pins.length})</div>`;
	if (isKicad && kPins.length > 0) {
		let shiftVal = '0';
		if (comp.overrides?.type === 'shift') shiftVal = comp.overrides.offset.toString();
		else if (comp.overrides?.type === 'remap') shiftVal = 'custom';

		let shiftOptions = `<option value="custom">Custom</option>`;
		for (let i = 0; i < kPins.length; i++) {
			shiftOptions += `<option value="${i}" ${shiftVal === i.toString() ? 'selected' : ''}>${i}</option>`;
		}

		shiftUi = `
		<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
			<div class="prop-label" style="margin:0;">Pins (${comp.pins.length})</div>
			<div style="display:flex;align-items:center;gap:6px">
				<span class="prop-label" style="margin:0;">Shift</span>
				<select id="kicad-pin-shift" class="prop-input" style="width:64px;padding:0 2px;margin:0;height:18px;font-size:10px">
					${shiftOptions}
				</select>
			</div>
		</div>`;
	}

	document.getElementById('prop-panel').innerHTML = `
		<div class="prop-row">
			<div class="prop-label">Ref</div>
			<div class="prop-val">${comp.ref}</div>
		</div>
		<div class="prop-row">
			<div class="prop-label">Type</div>
			<div class="prop-val" style="color:${col}">${compLabel(comp.type)}</div>
		</div>
		<div class="prop-row">
			<div class="prop-label">Value</div>
			<input class="prop-input" id="pv" value="${comp.value}" placeholder="e.g. 10k">
		</div>
		${extraProps}
		<div id="kicad-extra-props"></div>
		<div class="prop-row" style="margin-top:6px; border-top:1px solid var(--border); padding-top:6px;">
			${shiftUi}
			${comp.pins.map((p, i) => {
				let mappingUi = '';
				if (isKicad) {
					const options = kPins.map(kp =>
						`<option value="${kp.num}" ${kp.num === p.name ? 'selected' : ''}>${kp.num}</option>`
					).join('');
					mappingUi = `<div style="display:flex;align-items:center;gap:6px">
						<span style="color:var(--text2);width:16px">${p.originalName || p.name}</span>
						<span style="color:var(--border)">→</span>
						<select class="prop-input kicad-pin-map" data-orig="${p.originalName}" style="width:48px;padding:0 2px;margin:0;height:18px;font-size:10px">${options}</select>
					</div>`;
				} else {
					const mappingStr = p.name !== (p.originalName || p.name) ? ` <span style="color:var(--warn)">→${p.name}</span>` : '';
					mappingUi = `<span style="color:var(--text2)">${p.originalName || p.name}${mappingStr}</span>`;
				}

				return `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid var(--border)">
					${mappingUi}
					<span style="color:${p.net ? getNetColor(p.net) : 'var(--border)'}">${p.net || '—'}</span>
				</div>`;
			}).join('')}
		</div>
		<div style="margin-top:8px">
			<button class="btn accent" id="pa" style="width:100%">Apply</button>
		</div>
		<div style="margin-top:8px;color:var(--text2);font-size:10px;line-height:1.6">
			Right-click / long-press to rotate or replace.
		</div>`;

	// ── Sync Shift Dropdown and Individual Pin Selects ──
	if (isKicad && kPins.length > 0) {
		const shiftSelect = document.getElementById('kicad-pin-shift');
		const pinSelects = Array.from(document.querySelectorAll('.kicad-pin-map'));

		const checkShiftState = () => {
			let detectedOffset = -1;
			for (let offset = 0; offset < kPins.length; offset++) {
				let isMatch = true;
				for (let i = 0; i < comp.pins.length; i++) {
					const mappedNum = pinSelects[i].value;
					const expectedNum = kPins[(i + offset) % kPins.length]?.num;
					if (mappedNum !== expectedNum) {
						isMatch = false; break;
					}
				}
				if (isMatch) { detectedOffset = offset; break; }
			}
			shiftSelect.value = detectedOffset >= 0 ? detectedOffset.toString() : 'custom';
		};

		shiftSelect.addEventListener('change', () => {
			if (shiftSelect.value === 'custom') return;
			const offset = parseInt(shiftSelect.value);
			pinSelects.forEach((sel, i) => {
				const expectedNum = kPins[(i + offset) % kPins.length]?.num;
				sel.value = expectedNum;
			});
		});

		pinSelects.forEach(sel => sel.addEventListener('change', checkShiftState));
	}

	// Dynamically fetch and render extra DB properties for KiCad symbols
	if (comp.componentTypeId) {
		db.getResolvedKicadDataForComponentType(comp.componentTypeId).then(kSym => {
			if (!kSym) return;
			const container = document.getElementById('kicad-extra-props');
			if (!container) return; // Panel might have been closed/switched

			let html = '';
			if (kSym.description) {
				html += `
					<div class="prop-row" style="margin-top:6px;">
						<div class="prop-val" style="font-size:10px;line-height:1.3;color:var(--text2);word-wrap:break-word;">${kSym.description}</div>
					</div>`;
			}
			const footprint = kSym.footprint || kSym.fp_filters;
			if (footprint) {
				html += `
					<div class="prop-row">
						<div class="prop-val" style="font-size:10px;line-height:1.3;color:var(--text2);word-wrap:break-word;">FP: ${footprint}</div>
					</div>`;
			}
			if (kSym.datasheet && kSym.datasheet !== '~') {
				html += `
					<div class="prop-row" style="margin-top:6px;">
						<a href="${kSym.datasheet}" target="_blank" style="color:var(--accent2);text-decoration:underline;font-size:11px;">View Datasheet</a>
					</div>`;
			}
			container.innerHTML = html;
		});
	}

document.getElementById('pa').onclick = async () => {
		comp.value = document.getElementById('pv').value;

		if (comp.type === 'KICAD') {
			const selects = document.querySelectorAll('.kicad-pin-map');
			if (selects.length > 0) {
				const newMap = {};
				selects.forEach(sel => { newMap[sel.getAttribute('data-orig')] = sel.value; });

				let detectedOffset = -1;
				// Detect if the mapping is a uniform CCW shift
				for (let offset = 0; offset < kPins.length; offset++) {
					let isMatch = true;
					for (let i = 0; i < comp.pins.length; i++) {
						const orig = comp.pins[i].originalName;
						const mappedNum = newMap[orig];
						const expectedNum = kPins[(i + offset) % kPins.length]?.num;
						if (mappedNum !== expectedNum) {
							isMatch = false;
							break;
						}
					}
					if (isMatch) {
						detectedOffset = offset;
						break;
					}
				}

				if (detectedOffset === 0) {
					comp.overrides = null; // Identity mapping
				} else if (detectedOffset > 0) {
					comp.overrides = { type: 'shift', offset: detectedOffset };
				} else {
					// Fallback identity check just in case
					let isIdentity = true;
					for (let i = 0; i < comp.pins.length; i++) {
						if (newMap[comp.pins[i].originalName] !== kPins[i]?.num) {
							isIdentity = false; break;
						}
					}
					if (isIdentity) comp.overrides = null;
					else comp.overrides = { type: 'remap', map: newMap };
				}
			}

			const m = await import('./app.js');
			m.applyPinOverrides(comp);
			const l = await import('./layout.js');
			await l.buildAndRoute({}, false);
			m.saveComponentLayout(comp.id);
		} else {
			const newCount = parseInt(document.getElementById('ppc').value) || comp.pins.length;
			const minCount = Math.max(1, comp.pins.filter(p => p.net).length);
			const safeCount = Math.max(minCount, newCount);

			if (safeCount > comp.pins.length) {
				let nextPin = 1;
				while (comp.pins.length < safeCount) {
					if (!comp.pins.find(p => p.originalName === String(nextPin))) {
						comp.pins.push({ name: String(nextPin), originalName: String(nextPin), net: null });
					}
					nextPin++;
				}
			} else if (safeCount < comp.pins.length) {
				const keptPins = new Array();
				comp.pins.forEach(p => { if (p.net || keptPins.length < safeCount) keptPins.push(p); });
				comp.pins = keptPins;
			}

			const l = await import('./layout.js');
			await l.buildAndRoute({}, false);
			const m = await import('./app.js');
			m.saveComponentLayout(comp.id);
		}

		updateSidePanels();
		showProperties(comp);
		toast('Updated ' + comp.ref);
	};

}

export function showNetProperties(net) {
	document.getElementById('right-panel')?.classList.add('open');
	const col  = net.color || getNetColor(net.name);
	const rows = (net.nodes || new Array()).map(nd => {
		const comp = S.components.find(c => c.ref === nd.ref);
		const cCol = comp ? compColor(comp.type) : '#94a3b8';
		return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)">
			<span style="color:${cCol}">${nd.ref}</span>
			<span style="color:${col};font-size:10px">pin ${nd.pin}</span>
		</div>`;
	}).join('');
	document.getElementById('prop-panel').innerHTML = `
		<div class="prop-row">
			<div class="prop-label">Net</div>
			<div class="prop-val" style="color:${col}">${net.name}</div>
		</div>
		<div class="prop-row">
			<div class="prop-label">Connections (${(net.nodes || new Array()).length})</div>
			${rows || '<div style="color:var(--text2);font-size:10px">No connections</div>'}
		</div>`;
}

export function showDefaultProps() {
	document.getElementById('right-panel')?.classList.remove('open');
	document.getElementById('prop-panel').innerHTML =
		'<div style="color:var(--text2);font-size:10px;text-align:center;margin-top:20px">' +
		'Click a component or wire to select.<br><br>' +
		'Drag component to move.<br>Right-click for rotation.</div>';
}

// ── Side panels ───────────────────────────────────────────────
export function updateSidePanels() {
	// Net list
	const nl = document.getElementById('net-list');
	nl.innerHTML = '';
	S.nets.forEach(net => {
		const d = document.createElement('div');
		d.className = 'net-item' + (net.isWip ? ' wip' : '') +
									(S.selectedNet === net.name ? ' selected' : '');
		d.innerHTML = `<span class="net-dot" style="background:${net.color}"></span>
									 <span>${net.name}</span>
									 <span class="nc">${net.nodes.length}⬥</span>`;
		d.onclick = () => {
			if (window.innerWidth <= 800) document.getElementById('left-panel')?.classList.remove('open');
			S.selectedNet  = S.selectedNet === net.name ? null : net.name;
			S.selectedComp = null; S.selectedWire = null;
			if (S.selectedNet) showNetProperties(net); else showDefaultProps();
			updateSidePanels(); render();
		};
		nl.appendChild(d);
	});

	// Component list
	const cl = document.getElementById('comp-list');
	cl.innerHTML = '';
	S.components.forEach(c => {
		const d = document.createElement('div');
		d.className = 'comp-item' + (S.selectedComp === c.id ? ' selected' : '');
		d.innerHTML = `<span class="cdot" style="background:${compColor(c.type)}"></span>
									 <span>${c.ref}</span>
									 <span style="margin-left:auto;color:var(--text2);font-size:10px">${c.value}</span>`;
		d.onclick = () => {
			if (window.innerWidth <= 800) document.getElementById('left-panel')?.classList.remove('open');
			S.selectedComp = c.id; S.selectedWire = null; S.selectedNet = null;
			showProperties(c); updateSidePanels(); render();
		};
		cl.appendChild(d);
	});
}

// ── Export modal ───────────────────────────────────────────────
let _expFile = '', _expContent = '';
export function showExport(title, content, fname) {
	_expFile	= fname;
	_expContent = content;
	document.getElementById('export-title').textContent	  = title;
	document.getElementById('export-content').textContent = content;
	showModal('modal-export');
}

// ── Button wiring (called once from app.js) ───────────────────
export function initUI(mode, importNetlistStandalone, resetLayout, hasLayoutData) {
	const isEmbedded = mode === 'embedded';

	const btnLeft = document.getElementById('btn-toggle-left');
	if (btnLeft) btnLeft.onclick = () => document.getElementById('left-panel').classList.toggle('open');

	const btnRight = document.getElementById('btn-toggle-right');
	if (btnRight) btnRight.onclick = () => document.getElementById('right-panel').classList.toggle('open');

	const hideEl = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

	// In embedded mode, hide standalone-only controls
	if (isEmbedded) {
		hideEl('btn-load-db');
		hideEl('btn-import-file');
		hideEl('es-load-btn');
	}
	initLibraryManager();

	// Load-from-DB button — repurposed as a hint in standalone mode
	const loadBtn = document.getElementById('btn-load-db');
	if (loadBtn && !isEmbedded) {
		loadBtn.onclick = () => {
			localStorage.setItem('pcb_startup_tab', 'schema');
			window.location.href = 'studio.html';
		}
	}

	// Empty-state button — opens import modal in standalone mode
	const esBtn = document.getElementById('es-load-btn');
	if (esBtn && !isEmbedded) {
		esBtn.onclick = () => {
			document.getElementById('import-textarea').value = '';
			document.getElementById('file-name').textContent = 'No file';
			showModal('modal-import');
		};
	}

	// Import button in header
	const importBtn = document.getElementById('btn-import-file');
	if (importBtn && !isEmbedded) {
		importBtn.onclick = () => {
			document.getElementById('import-textarea').value = '';
			document.getElementById('file-name').textContent = 'No file';
			showModal('modal-import');
		};
	}

	document.getElementById('btn-auto-place').onclick = async () => {
		if (!S.hasData) { toast('No netlist', 'warn'); return; }
		if (hasLayoutData && hasLayoutData()) {
			// Use Studio's confirmAction if available (embedded), else use confirm()
			const message = 'Reset layout? All manually placed positions will be lost.';
			const ok = window.parent?.confirmAction
				? await window.parent.confirmAction(message, 'Reset Layout')
				: window.confirm(message);
			if (!ok) return;
		}
		pushHistory();
		if (resetLayout) await resetLayout();
		toast('Auto layout applied');
	};

	// fitView already calls render() internally
	document.getElementById('btn-zoom-fit').onclick	 = fitView;
	document.getElementById('btn-zoom-fit2').onclick = fitView;
	document.getElementById('btn-zoom-in').onclick	 = () => { S.zoom = Math.min(8, S.zoom * 1.25); render(); };
	document.getElementById('btn-zoom-out').onclick	 = () => { S.zoom = Math.max(0.1, S.zoom / 1.25); render(); };
	document.getElementById('btn-undo').onclick		 = undo;

	// Import modal — file picker and OK
	const pickBtn = document.getElementById('btn-pick-file');
	if (pickBtn) pickBtn.onclick = () => document.getElementById('file-input').click();
	document.getElementById('file-input').onchange = e => {
		const f = e.target.files[0]; if (!f) return;
		document.getElementById('file-name').textContent = f.name;
		const r = new FileReader();
		r.onload = ev => document.getElementById('import-textarea').value = ev.target.result;
		r.readAsText(f);
	};
	document.getElementById('btn-import-cancel').onclick = () => hideModal('modal-import');
	document.getElementById('btn-import-ok').onclick = () => {
		const text	= document.getElementById('import-textarea').value.trim();
		const fname = document.getElementById('file-name').textContent;
		if (!text) { toast('Nothing to import', 'err'); return; }
		hideModal('modal-import');
		if (importNetlistStandalone) {
			importNetlistStandalone(text, fname !== 'No file' ? fname : 'Imported Netlist');
		}
	};

	// Export buttons
	document.getElementById('btn-export-kicad').onclick = () => {
		if (!S.hasData) { toast('No schematic', 'warn'); return; }
		import('./io.js').then(async m => showExport('KiCad Schematic (.kicad_sch)', await m.exportKiCad(), await m.getExportFilename('kicad_sch')));
	};
/*
	document.getElementById('btn-export-spice').onclick = () => {
		if (!S.hasData) { toast('No schematic', 'warn'); return; }
		import('./io.js').then(async m => showExport('SPICE (.cir) — LTspice/ngspice/KiCad Sim/MicroCAP', m.exportSpice(), await m.getExportFilename('cir')));
	};
*/
	// Export modal actions
	document.getElementById('btn-export-close').onclick	   = () => hideModal('modal-export');
	document.getElementById('btn-export-copy').onclick	   = () =>
		navigator.clipboard.writeText(_expContent).then(() => toast('Copied'));
	document.getElementById('btn-export-download').onclick = () => {
		const a = document.createElement('a');
		a.href	   = URL.createObjectURL(new Blob([_expContent], { type: 'text/plain' }));
		a.download = _expFile;
		a.click();
		toast('Downloaded ' + _expFile);
	};

	// Close modal on backdrop click
	document.querySelectorAll('.modal-overlay').forEach(o =>
		o.addEventListener('click', e => { if (e.target === o) o.classList.remove('active'); })
	);
}

// ── Library Manager Modal ──────────────────────────────────────
function initLibraryManager() {
	const modal = document.getElementById('modal-library-manager');
	const btnOpen = document.getElementById('btn-lib-mgr');

	const defaultUi = document.getElementById('lib-default-ui');
	const zipUi = document.getElementById('lib-zip-explorer');
	const treeEl = document.getElementById('zip-tree');
	const logEl = document.getElementById('lib-import-log');

	let currentZip = null;
	let libsData = {};

	const log = (msg) => { logEl.innerHTML += `<div>${msg}</div>`; logEl.scrollTop = logEl.scrollHeight; };
	const resetZipUi = () => {
		if (currentZip?.reader) currentZip.reader.close().catch(() => {});
		currentZip = null;
		libsData = {};
		defaultUi.style.display = 'flex';
		zipUi.style.display = 'none';
	};

	if (btnOpen) btnOpen.onclick = () => { modal.classList.add('active'); resetZipUi(); };

	document.getElementById('btn-lib-close').onclick = () => { modal.classList.remove('active'); logEl.innerHTML = ''; resetZipUi(); };
	document.getElementById('btn-zip-cancel').onclick = resetZipUi;

	document.getElementById('btn-zip-sel-all').onclick = () => document.querySelectorAll('.cb-lib').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change')); });
	document.getElementById('btn-zip-sel-none').onclick = () => document.querySelectorAll('.cb-lib').forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change')); });

	async function processZipBuffer(buffer) {
		log('Parsing ZIP directory structure...');
		const { ZipReader, Uint8ArrayReader } = zip;
		const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)), {
			// useWebWorkers: false,
			useCompressionStream: true
		});
		const entries = await reader.getEntries();

		// Keep reader open — needed later when user clicks Import
		currentZip = { reader, entries };

		libsData = {};
		entries
			.filter(e => !e.directory && e.filename.endsWith('.kicad_sym'))
			.forEach(e => {
				const match = e.filename.match(/([^\/]+)\.kicad_symdir\//);
				const libName = match ? match[1] : 'Imported';
				if (!libsData[libName]) libsData[libName] = [];
				libsData[libName].push({ path: e.filename, name: e.filename.split('/').pop().replace('.kicad_sym', '') });
			});

		treeEl.innerHTML = '';
		Object.keys(libsData).sort().forEach(libName => {
			const libDiv = document.createElement('div');
			libDiv.style.marginBottom = '6px';

			const head = document.createElement('div');
			head.style.display = 'flex'; head.style.alignItems = 'center'; head.style.gap = '6px';

			const cb = document.createElement('input');
			cb.type = 'checkbox'; cb.className = 'cb-lib'; cb.dataset.lib = libName;

			const lbl = document.createElement('span');
			lbl.textContent = `${libName} (${libsData[libName].length} symbols)`;
			lbl.style.flex = '1'; lbl.style.cursor = 'pointer';
			lbl.onclick = () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); };

			const btnExp = document.createElement('button');
			btnExp.textContent = '▼';
			btnExp.style.background = 'none'; btnExp.style.border = 'none'; btnExp.style.color = 'var(--text2)'; btnExp.style.cursor = 'pointer';

			head.appendChild(cb); head.appendChild(lbl); head.appendChild(btnExp);
			libDiv.appendChild(head);

			const symsDiv = document.createElement('div');
			symsDiv.style.display = 'none'; symsDiv.style.paddingLeft = '20px'; symsDiv.style.flexDirection = 'column'; symsDiv.style.marginTop = '4px';

			let rendered = false;
			btnExp.onclick = () => {
				if (symsDiv.style.display === 'none') {
					symsDiv.style.display = 'flex'; btnExp.textContent = '▲';
					if (!rendered) {
						libsData[libName].forEach(sym => {
							const sRow = document.createElement('label');
							sRow.style.display = 'flex'; sRow.style.gap = '6px'; sRow.style.fontSize = '10px'; sRow.style.color = 'var(--text)';
							const sCb = document.createElement('input');
							sCb.type = 'checkbox'; sCb.className = `cb-sym cb-sym-${libName}`; sCb.dataset.path = sym.path;
							sCb.checked = cb.checked;
							sCb.onchange = () => {
								const allSyms = Array.from(document.querySelectorAll(`.cb-sym-${libName}`));
								const checkedCount = allSyms.filter(x => x.checked).length;
								cb.checked = checkedCount === allSyms.length;
								cb.indeterminate = checkedCount > 0 && checkedCount < allSyms.length;
							};
							sRow.appendChild(sCb); sRow.appendChild(document.createTextNode(sym.name));
							symsDiv.appendChild(sRow);
						});
						rendered = true;
					}
				} else {
					symsDiv.style.display = 'none'; btnExp.textContent = '▼';
				}
			};

			cb.onchange = () => {
				cb.indeterminate = false;
				if (rendered) document.querySelectorAll(`.cb-sym-${libName}`).forEach(x => x.checked = cb.checked);
			};

			libDiv.appendChild(symsDiv);
			treeEl.appendChild(libDiv);
		});

		defaultUi.style.display = 'none';
		zipUi.style.display = 'flex';
	}

	document.getElementById('btn-zip-import').onclick = async () => {
		const selectedPaths = new Array();
		document.querySelectorAll('.cb-lib').forEach(cbLib => {
			const libName = cbLib.dataset.lib;
			const symsDiv = cbLib.parentElement.nextElementSibling;
			const rendered = symsDiv.children.length > 0;

			if (rendered) {
				document.querySelectorAll(`.cb-sym-${libName}:checked`).forEach(sCb => selectedPaths.push(sCb.dataset.path));
			} else if (cbLib.checked) {
				libsData[libName].forEach(sym => selectedPaths.push(sym.path));
			}
		});

		if (selectedPaths.length === 0) return toast('No files selected', 'warn');

		// Detach without closing — importSelectedFromZip owns the reader now and will close it
		const zipRef = currentZip;
		currentZip = null;
		libsData = {};
		defaultUi.style.display = 'flex';
		zipUi.style.display = 'none';

		log(`Extracting and parsing ${selectedPaths.length} files...`);
		try {
			const stats = await importSelectedFromZip(zipRef, selectedPaths, (msg) => {
				// Update last line if it looks like a progress message, otherwise append
				const last = logEl.lastElementChild;
				if (last && last.dataset.progress) {
					last.textContent = msg;
				} else {
					const div = document.createElement('div');
					div.dataset.progress = '1';
					div.textContent = msg;
					logEl.appendChild(div);
				}
				logEl.scrollTop = logEl.scrollHeight;
			});
			log(`Success: <span style="color:#4ade80">${stats.inserted} inserted</span>, <span style="color:#f0c040">${stats.updated} updated</span>.`);
			toast('Import Complete', 'ok');
		} catch (err) { log(`<span style="color:var(--accent3)">Error: ${err.message}</span>`); }
	};

	document.getElementById('btn-lib-import-url').onclick = async () => {
		const url = document.getElementById('lib-remote-url').value.trim();
		if (!url) return toast('Please enter a URL', 'warn');
		log(`Fetching ${url}...`);
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			if (url.endsWith('.zip')) {
				const buf = await res.arrayBuffer();
				await processZipBuffer(buf);
			} else {
				const text = await res.text();
				const libName = url.split('/').pop().replace('.kicad_sym', '');
				const stats = await importSymbolsFromText(text, libName);
				log(`Success: <span style="color:#4ade80">${stats.inserted} inserted</span>, <span style="color:#f0c040">${stats.updated} updated</span> into '${libName}'.`);
				toast('Library Imported Successfully', 'ok');
			}
		} catch (err) { log(`<span style="color:var(--accent3)">Error: ${err.message}</span>`); }
	};

	const fileInput = document.getElementById('lib-file-input');
	document.getElementById('btn-lib-pick-file').onclick = () => fileInput.click();

	fileInput.onchange = async (e) => {
		const f = e.target.files[0];
		if (!f) return;
		document.getElementById('lib-file-name').textContent = f.name;
		log(`Reading local file: ${f.name}...`);
		try {
			if (f.name.endsWith('.zip')) {
				const buf = await f.arrayBuffer();
				await processZipBuffer(buf);
			} else {
				const text = await f.text();
				const libName = f.name.replace('.kicad_sym', '');
				const stats = await importSymbolsFromText(text, libName);
				log(`Success: <span style="color:#4ade80">${stats.inserted} inserted</span>, <span style="color:#f0c040">${stats.updated} updated</span> into '${libName}'.`);
				toast('Library Imported Successfully', 'ok');
			}
		} catch (err) { log(`<span style="color:var(--accent3)">Error: ${err.message}</span>`); }
		fileInput.value = '';
	};
}

// ── Replace Symbol Modal ──────────────────────────────────────
export async function showReplaceSymbolModal(comp) {
	const modal = document.getElementById('modal-replace-symbol');
	const listEl = document.getElementById('sym-list');
	const searchEl = document.getElementById('sym-search');

	listEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text2);">Loading Library...</div>';
	modal.classList.add('active');

	const t0 = performance.now();

	const targetPinCount = comp.pins.length;
	// Instantly fetch ONLY the components that match the required pin count using the DB index
	const matchingSyms = await db.getKicadSymbolsByPinCount(targetPinCount);

	const t1 = performance.now();
	// console.log(`[Perf] DB Fetch/Cache: ${matchingSyms.length} records in ${(t1 - t0).toFixed(1)}ms`);

	// Parse JSON only for the few thousand that actually matched pin count
	const validSyms = matchingSyms.map(s => ({ ...s, parsed: JSON.parse(s.parsedData) }));

	const t2 = performance.now();
	// console.log(`[Perf] Fast Filter & Selective Parse: left ${validSyms.length} records in ${(t2 - t1).toFixed(1)}ms`);

	const renderList = (filterText = '') => {
		listEl.innerHTML = '';

		// 1. Parse the search string
		const terms = filterText.toLowerCase().split(/\s+/).filter(Boolean);
		const filters = { name: null, lib: null, ref: null, desc: null, pins: null, text: new Array() };

		terms.forEach(term => {
			if (term.startsWith('name:')) filters.name = term.slice(5);
			else if (term.startsWith('lib:')) filters.lib = term.slice(4);
			else if (term.startsWith('ref:')) filters.ref = term.slice(4);
			else if (term.startsWith('desc:')) filters.desc = term.slice(5);
			else filters.text.push(term);
		});

		// 2. Filter the symbols
		const filtered = validSyms.filter(s => {
			if (filters.name && !s.symbol.toLowerCase().includes(filters.name)) return false;
			if (filters.lib && !s.library.toLowerCase().includes(filters.lib)) return false;
			if (filters.ref && !(s.reference || '').toLowerCase().includes(filters.ref)) return false;
			if (filters.desc && !(s.description || '').toLowerCase().includes(filters.desc)) return false;

			if (filters.text.length > 0) {
				const combinedText =[
					s.symbol,
					s.library,
					s.description || '',
					s.keywords || '',
					s.fp_filters || ''
				].join(' ').toLowerCase();

				// All general text terms must match somewhere in the combined text
				if (!filters.text.every(t => combinedText.includes(t))) return false;
			}
			return true;
		});

		// 3. Render the list
		if (filtered.length === 0) {
			listEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text2);">No matching symbols found.</div>';
			return;
		}

		filtered.forEach(s => {
			const item = document.createElement('div');
			item.className = 'db-item';

			const symNameHtml = s.datasheet && s.datasheet !== '~'
				? `<a href="${s.datasheet}" target="_blank" style="font-weight:bold; color:var(--accent2); text-decoration:underline;" onclick="event.stopPropagation()">${s.symbol}</a>`
				: `<span style="font-weight:bold; color:var(--accent);">${s.symbol}</span>`;

			item.innerHTML = `
				<div style="display:flex; flex-direction:column; max-width:70%;">
					<div style="display:flex; align-items:center; gap:6px;">
						<span style="font-size:9px; background:var(--surface2); padding:2px 4px; border-radius:3px; color:var(--text2);">${s.library}</span>
						${symNameHtml}
					</div>
					<span style="font-size:10px; color:var(--text2); margin-top:4px;">${s.description || 'No description'}</span>
				</div>
				<div style="text-align:right; font-size:10px; color:var(--text2); line-height:1.4;">
					<span style="color:var(--accent)">Ref: ${s.reference || '?'}</span><br>
					${s.fp_filters ? `FP: ${s.fp_filters.substring(0, 15)}...<br>` : ''}
					${s.parsed.pins.length} pins
				</div>
			`;
			item.onclick = async () => {
				modal.classList.remove('active');
				await applyKiCadSymbolReplacement(comp, s);
			};
			listEl.appendChild(item);
		});
	};

	// Setup smart default search string
	let defaultSearch = '';
	if (['R','C','L','D','Z'].includes(comp.type)) {
		defaultSearch = `lib:device ref:${comp.type}`;
	} else {
		const refMatch = comp.ref.match(/^[A-Za-z]+/);
		defaultSearch = comp.value ? comp.value : (refMatch ? `ref:${refMatch[0]}` : '');
	}

	searchEl.value = defaultSearch;
	renderList(defaultSearch);
	searchEl.oninput = (e) => renderList(e.target.value);
	document.getElementById('btn-replace-cancel').onclick = () => modal.classList.remove('active');
}

async function applyKiCadSymbolReplacement(comp, kicadSym) {
	let ct = await db.getComponentTypeForKicadSymbol(kicadSym.id);
	if (!ct) {
		const newCtId = uuid();
		await db.saveComponentType({ id: newCtId, symbolTypeId: null, name: kicadSym.symbol, pinCount: kicadSym.parsed.pins.length, created: Date.now(), lastModified: Date.now() });
		await db.saveComponentTypeKicadSymbol({ id: uuid(), componentTypeId: newCtId, kicadSymbolId: kicadSym.id, isPrimary: 1 });
		ct = { id: newCtId };
	}

	const pinMap = {};
	comp.pins.forEach((p, i) => {
		if (kicadSym.parsed.pins[i]) p.name = kicadSym.parsed.pins[i].num;
		pinMap[i + 1] = i + 1; // 1:1 mapping mapping for existing pins based on count
	});

	comp.type = 'KICAD';
	comp.componentTypeId = ct.id;
	comp.kicadData = { name: kicadSym.symbol, ...kicadSym.parsed };

	// Because we replaced the symbol, use the optimized replacement route
	import('./layout.js').then(l => l.replaceComponentRoute(comp, pinMap)).then(() => {
		import('./app.js').then(({ saveComponentLayout }) => saveComponentLayout(comp.id));
	});
	toast(`Replaced with: ${kicadSym.symbol}`);
}
