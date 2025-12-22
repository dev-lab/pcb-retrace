/* studio.js - Main Application Logic */

const DB_NAME = 'PcbReTrace'; const DB_VER = 1;

const ICONS = { RESISTOR: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="12" rx="3" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1"/><rect x="7" y="6" width="2" height="12" fill="#ef4444"/><rect x="11" y="6" width="2" height="12" fill="#000000"/><rect x="15" y="6" width="2" height="12" fill="#ef4444"/><line x1="1" y1="12" x2="4" y2="12" stroke="#94a3b8" stroke-width="2"/><line x1="20" y1="12" x2="23" y2="12" stroke="#94a3b8" stroke-width="2"/></svg>`, INDUCTOR: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="4" fill="#bbf7d0" stroke="#22c55e" stroke-width="1"/><rect x="7" y="5" width="2" height="14" fill="#cbd5e1"/><rect x="11" y="5" width="2" height="14" fill="#ef4444"/><rect x="15" y="5" width="2" height="14" fill="#ef4444"/><line x1="1" y1="12" x2="4" y2="12" stroke="#94a3b8" stroke-width="2"/><line x1="20" y1="12" x2="23" y2="12" stroke="#94a3b8" stroke-width="2"/></svg>`, COIL: `<svg viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round"><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/><path d="M5 12 C5 4 9 4 9 12"/><path d="M9 12 C9 19 10 19 10 12" stroke-opacity="0.5"/><path d="M10 12 C10 4 14 4 14 12"/><path d="M14 12 C14 19 15 19 15 12" stroke-opacity="0.5"/><path d="M15 12 C15 4 19 4 19 12"/></svg>` };
const TOOL_REGISTRY = { 'R': [{url:'resistor.html',icon:ICONS.RESISTOR,title:'Resistor'}], 'L': [{url:'inductor.html',icon:ICONS.INDUCTOR,title:'Inductor'},{url:'coil.html',icon:ICONS.COIL,title:'Coil'}] };
const MAX_DIRECT_TOOLS = 3;

// Global State
let db=null, deviceList=[], currentDeviceId=null, bomList=[], currentBomId=null, bomData=[], bomImages=[], currentImgId=null, sortMode='none', editingIndex=-1, mapState={scale:1,x:0,y:0,isDragging:false,startX:0,startY:0};
let skipNextFit = false;
let returnToMap = false;
let spyglass = null;
let isMainViewActive = true; // Tracks if Spyglass is showing the actual source image

// Phase 6 Extensions
let cvManager = null;
let stitchEditor = null;
let currentOverlaps = [];
let netManager = null;
let inspector = null;

// Utility: Global UUID generator (used by StitchEditor too)
window.uuid = function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);}); }

class PcbDatabase {
	constructor() { this.name=DB_NAME; this.ver=DB_VER; }
	async init() { return new Promise((r,j)=>{
		const q=indexedDB.open(this.name,this.ver);
		q.onupgradeneeded=e=>{
			const d=e.target.result;
			if(d.objectStoreNames.contains('projects')) d.deleteObjectStore('projects');
			if(!d.objectStoreNames.contains('devices')) d.createObjectStore('devices',{keyPath:'id'});
			if(!d.objectStoreNames.contains('boards')) { const bs=d.createObjectStore('boards',{keyPath:'id'}); bs.createIndex('deviceId','deviceId',{unique:false}); }
			if(!d.objectStoreNames.contains('components')) { const cs=d.createObjectStore('components',{keyPath:'id'}); cs.createIndex('boardId','boardId',{unique:false}); }
			if(!d.objectStoreNames.contains('images')) { const is=d.createObjectStore('images',{keyPath:'id'}); is.createIndex('boardId','boardId',{unique:false}); }

			// v6: POI Support
			if(!d.objectStoreNames.contains('overlappedImages')) {
				const os=d.createObjectStore('overlappedImages',{keyPath:'id'});
				os.createIndex('fromImageId','fromImageId');
			}
			// v7: Nets Store
			if(!d.objectStoreNames.contains('nets')) {
				const ns=d.createObjectStore('nets',{keyPath:'id'});
				// No index needed yet as we usually load all nets for a board via manual filter or ID list
			}

		};
		q.onsuccess=e=>{this.db=e.target.result;r()};
		q.onerror=e=>{ console.error("DB Open Error:", e); j(e); };
	}); }

	// Helpers
	async _tx(s,m,cb){ return new Promise((r,j)=>{const t=this.db.transaction(s,m); const q=cb(t.objectStore(s)); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error);}); }
	async _ix(s,i,v){ return new Promise((r,j)=>{const q=this.db.transaction(s,'readonly').objectStore(s).index(i).getAll(v); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error);}); }

	// Core CRUD
	async getDevices() { return this._tx('devices','readonly',s=>s.getAll()); }
	async addDevice(d) { return this._tx('devices','readwrite',s=>s.put(d)); }
	async getProjectsByDevice(devId) { return this._ix('boards', 'deviceId', devId); }
	async getProject(id) { return this._tx('boards','readonly',s=>s.get(id)); }
	async addProject(p) { return this._tx('boards','readwrite',s=>s.put(p)); }
	async deleteProject(id) { const cs=await this.getComponents(id); const is=await this.getImages(id); const tx=this.db.transaction(['boards','components','images'],'readwrite'); cs.forEach(c=>tx.objectStore('components').delete(c.id)); is.forEach(i=>tx.objectStore('images').delete(i.id)); tx.objectStore('boards').delete(id); return new Promise(r=>tx.oncomplete=r); }
	async getComponents(pid) { return this._ix('components','boardId',pid); }
	async addComponent(c) { return this._tx('components','readwrite',s=>s.put(c)); }
	async deleteComponent(id) { return this._tx('components','readwrite',s=>s.delete(id)); }
	async clearComponents(pid) { const cs=await this.getComponents(pid); const tx=this.db.transaction('components','readwrite'); cs.forEach(c=>tx.objectStore('components').delete(c.id)); return new Promise(r=>tx.oncomplete=r); }
	async clearProjectData(pid) { const cs=await this.getComponents(pid); const is=await this.getImages(pid); const tx=this.db.transaction(['components','images'],'readwrite'); cs.forEach(c=>tx.objectStore('components').delete(c.id)); is.forEach(i=>tx.objectStore('images').delete(i.id)); return new Promise(r=>tx.oncomplete=r); }
	async getImages(pid) { return this._ix('images','boardId',pid); }
	async addImage(i) { return this._tx('images','readwrite',s=>s.put(i)); }
	async deleteImage(id) { return this._tx('images','readwrite',s=>s.delete(id)); }
	async getImage(id) { return this._tx('images', 'readonly', s => s.get(id)); }
	async getNets() { return this._tx('nets','readonly',s=>s.getAll()); }
	async addNet(n) { return this._tx('nets','readwrite',s=>s.put(n)); }
	async deleteNet(id) { return this._tx('nets','readwrite',s=>s.delete(id)); }

	// POI Extensions
	async addOverlap(ov) { return this._tx('overlappedImages','readwrite',s=>s.put(ov)); }
	async getOverlapsForPair(id1, id2) {
		 const all = await this._tx('overlappedImages','readonly',s=>s.getAll());
		 return all.find(x => (x.fromImageId===id1 && x.toImageId===id2) || (x.fromImageId===id2 && x.toImageId===id1));
	}
	async getOverlapsForImage(id) {
		 const all = await this._tx('overlappedImages','readonly',s=>s.getAll());
		 return all.filter(x => x.fromImageId===id || x.toImageId===id);
	}
	async deleteOverlapsForPair(id1, id2) {
		const tx = this.db.transaction('overlappedImages', 'readwrite');
		const store = tx.objectStore('overlappedImages');
		const req = store.getAll();
		return new Promise(resolve => {
			req.onsuccess = e => {
				const all = e.target.result;
				const toDel = all.filter(x => (x.fromImageId===id1 && x.toImageId===id2) || (x.fromImageId===id2 && x.toImageId===id1));
				let c=0;
				if(toDel.length===0) resolve();
				toDel.forEach(item => { store.delete(item.id).onsuccess=()=>{ c++; if(c===toDel.length) resolve(); }});
			}
		});
	}
}

// MAIN INIT
async function init() {
	db = new PcbDatabase();
	await db.init();

	if (!history.state) {
		history.replaceState({ context: 'list' }, "", "");
	}

	cvManager = new CVManager();
	cvManager.init(); // Lazy load (don't await)

	// Init net managers
	netManager = new NetManager(db);
	inspector = new Inspector(db, cvManager);

	// [CRITICAL] Expose to window so inline HTML onclicks (generated by Inspector) work
	window.netManager = netManager;
	window.inspector = inspector;

	stitchEditor = new StitchEditor(db, cvManager);

	deviceList = await db.getDevices();
	if(deviceList.length === 0) {
		const defDev = { id: uuid(), name: 'Default Device' };
		await db.addDevice(defDev);
		deviceList = [defDev];
		const bid = uuid();
		await db.addProject({ id: bid, deviceId: defDev.id, name: 'Main Board', sortMode:'none' });
	}

	currentDeviceId = localStorage.getItem('pcb_dev_id') || deviceList[0].id;
	if (!deviceList.find(d => d.id === currentDeviceId)) currentDeviceId = deviceList[0].id;

	updateDeviceDropdown();
	await loadDeviceBoms();

	document.getElementById('add-form').addEventListener('keydown', function(e) { if(e.key === 'Enter') addPart(); });
	if (typeof PcbSpyglass !== 'undefined') {
		spyglass = new PcbSpyglass('preview-canvas', 'zoom-level', (newX, newY) => {
			// When user drags the spyglass, update the hidden inputs (only for the Main View)
			if (isMainViewActive) {
				document.getElementById('inp-x').value = newX;
				document.getElementById('inp-y').value = newY;
			}
			// Optional: If we want real-time DB saving while dragging in the list view,
			// we could enable it, but usually updating inputs + clicking "Add/Update" is safer.
		});
	}

	// Check for ?import={url} parameter
	const urlParams = new URLSearchParams(window.location.search);
	const importUrl = urlParams.get('import');

	if (importUrl) {
		// 1. Clean URL immediately so refresh doesn't trigger loop
		const cleanLocation = window.location.protocol + "//" + window.location.host + window.location.pathname;
		window.history.replaceState({ context: 'list' }, '', cleanLocation);

		// 2. Trigger import (small delay to ensure DB/UI is ready)
		setTimeout(() => processUrlImport(importUrl), 500);
	}

	setupDragDrop();
	NavManager.init();
}

// Helper: Find all transitive connections for a given image
// Returns Array of { sourceId, matrix (Source->Target) }
async function getConnectedImages(targetImgId) {
	if (!targetImgId || !cvManager) return [];

	// Use Helper
	const paths = await ImageGraph.solvePaths(targetImgId, cvManager, db);

	// Map to expected format
	return paths.map(p => ({
		sourceId: p.id,
		matrix: p.H
	}));
}

function updateDeviceDropdown() {
	const s = document.getElementById('device-select'); s.innerHTML='';
	deviceList.forEach(d => {
		const o = document.createElement('option'); o.value=d.id; o.innerText=d.name;
		if(d.id===currentDeviceId) o.selected=true;
		s.appendChild(o);
	});
}

async function switchDevice() {
	resetStickyEditor();
	currentDeviceId = document.getElementById('device-select').value;
	localStorage.setItem('pcb_dev_id', currentDeviceId);
	await loadDeviceBoms();
}

async function loadDeviceBoms() {
	bomList = await db.getProjectsByDevice(currentDeviceId);
	const s = document.getElementById('bom-select'); s.innerHTML='';
	if (bomList.length === 0) {
		s.innerHTML = '<option disabled selected>No Boards</option>';
		currentBomId = null;
	} else {
		const groups = {};
		bomList.forEach(b => {
			const sec = b.section || "General";
			if(!groups[sec]) groups[sec] = [];
			groups[sec].push(b);
		});
		for (const [secName, boms] of Object.entries(groups)) {
			const grp = document.createElement('optgroup'); grp.label = secName;
			boms.forEach(b => {
				const o = document.createElement('option'); o.value=b.id; o.innerText=b.name;
				grp.appendChild(o);
			});
			s.appendChild(grp);
		}
		const lastBom = localStorage.getItem('pcb_bom_id');
		currentBomId = (lastBom && bomList.find(b=>b.id===lastBom)) ? lastBom : bomList[0].id;
		s.value = currentBomId;
	}
	await loadProjectData();
}

async function switchBom() {
	resetStickyEditor();
	currentBomId = document.getElementById('bom-select').value;
	localStorage.setItem('pcb_bom_id', currentBomId);
	currentImgId = null;
	await loadProjectData();
}

async function loadProjectData() {
	// Helper to refresh other tabs
	const refreshViews = async () => {
		if (window.netManager) window.netManager.render();
		if (window.inspector) {
			// Clear previous selection as IDs are no longer valid
			window.inspector.visibleIds.clear();
			window.inspector.activeNet = null; // Reset active net
			await window.inspector.init(); // Rebuild sidebar & grid
		}
	};

	if (!currentBomId) {
		bomData = [];
		bomImages = [];
		renderList();

		// FIX: Clear other views if no board selected
		const imgSel = document.getElementById('image-select');
		if(imgSel) imgSel.innerHTML = '<option disabled selected>No Images</option>';
		clearMap();
		await refreshViews();
		return;
	}

	const meta = bomList.find(p=>p.id===currentBomId);
	if (meta) {
		sortMode = (meta && meta.sortMode) ? meta.sortMode : 'none';
		document.getElementById('sort-select').value = sortMode;
	}

	bomData = await db.getComponents(currentBomId);
	bomImages = await db.getImages(currentBomId);

	// Convert raw blobs to Image objects for cache if needed (lazy loaded usually)
	for (const img of bomImages) {
		if (/\.(jpg|jpeg|png|webp)$/i.test(img.name)) {
			img.name = img.name.replace(/\.[^/.]+$/, "");
			db.addImage(img);
		}
	}

	const imgSel = document.getElementById('image-select');
	imgSel.innerHTML = '';
	if(bomImages.length > 0) {
		bomImages.forEach(img => {
			const opt = document.createElement('option');
			opt.value = img.id; opt.innerText = img.name;
			imgSel.appendChild(opt);
		});
		if(!currentImgId || !bomImages.find(i=>i.id===currentImgId)) currentImgId = bomImages[0].id;
		imgSel.value = currentImgId;

		// Only load the image if we are actually on the map tab
		if(document.getElementById('view-map').classList.contains('active')) showImage(currentImgId);
	} else {
		currentImgId = null;
		imgSel.innerHTML = '<option disabled selected>No Images</option>';
		clearMap();
	}

	renderList();

	// Refresh Nets and Inspector with new data
	await refreshViews();
}

async function createNewDevice() {
	const n = await requestInput("New Device", "Device Name", "");
	if (n) {
		const id = uuid();
		await db.addDevice({ id, name: n });
		currentDeviceId = id;
		const bid = uuid();
		await db.addProject({ id: bid, deviceId: id, name: 'Main Board', sortMode: 'none' });
		deviceList = await db.getDevices();
		updateDeviceDropdown();
		await loadDeviceBoms();
	}
}

async function createNewBom() {
	if (!currentDeviceId) return alert("Select a device first.");
	const n = await requestInput("New Board", "Board Name", "");
	if(n) {
		const sec = await requestInput("Section", "Group (Optional)", "") || "";
		const id=uuid();
		await db.addProject({id, deviceId: currentDeviceId, name:n, section: sec, lastModified:Date.now(), sortMode:'none'});
		currentBomId=id;
		await loadDeviceBoms();
	}
}

// --- SETTINGS ---
function openBoardSettings() {
	if (!currentBomId) return;
	const p = bomList.find(x => x.id === currentBomId);
	if (!p) return;
	document.getElementById('edit-board-name').value = p.name;
	document.getElementById('edit-board-section').value = p.section || "";
	const ds = document.getElementById('edit-board-device'); ds.innerHTML = '';
	deviceList.forEach(d => {
		const o = document.createElement('option'); o.value = d.id; o.innerText = d.name;
		if (d.id === p.deviceId) o.selected = true;
		ds.appendChild(o);
	});
	document.getElementById('board-settings-modal').style.display = 'flex';
}
async function saveBoardSettings() {
	const p = bomList.find(x => x.id === currentBomId);
	if (!p) return;
	const newName = document.getElementById('edit-board-name').value;
	const newSec = document.getElementById('edit-board-section').value;
	const newDevId = document.getElementById('edit-board-device').value;
	if (newName) {
		p.name = newName; p.section = newSec; p.deviceId = newDevId;
		await db.addProject(p);
		history.back();
		if (newDevId !== currentDeviceId) {
			currentDeviceId = newDevId;
			updateDeviceDropdown();
		}
		await loadDeviceBoms();
	}
}
function openDeviceSettings() {
	if (!currentDeviceId) return;
	const d = deviceList.find(x => x.id === currentDeviceId);
	if (!d) return;
	document.getElementById('edit-device-name').value = d.name;
	document.getElementById('device-settings-modal').style.display = 'flex';
}
async function saveDeviceSettings() {
	const d = deviceList.find(x => x.id === currentDeviceId);
	if (!d) return;
	const newName = document.getElementById('edit-device-name').value;
	if (newName && newName !== d.name) {
		d.name = newName;
		await db.addDevice(d);
		deviceList = await db.getDevices();
		updateDeviceDropdown();
	}
	history.back();
}
async function deleteCurrentDevice() {
	if (!currentDeviceId) return;

	// 1. Modal Check
	if (!await confirmAction("Are you sure? This will PERMANENTLY DELETE the device and ALL its boards, components, and images.\n\nThis action cannot be undone.", "Delete Device")) {
		return;
	}

	try {
		const boards = await db.getProjectsByDevice(currentDeviceId);
		for (const board of boards) {
			const images = await db.getImages(board.id);
			for (const img of images) {
				const overlaps = await db.getOverlapsForImage(img.id);
				const tx = db.db.transaction('overlappedImages', 'readwrite');
				const store = tx.objectStore('overlappedImages');
				overlaps.forEach(ov => store.delete(ov.id));
				await new Promise(r => tx.oncomplete = r);
			}
			await db.deleteProject(board.id);
		}

		await db._tx('devices', 'readwrite', s => s.delete(currentDeviceId));
		history.back();

		deviceList = await db.getDevices();
		if (deviceList.length === 0) {
			const defDev = { id: uuid(), name: 'Default Device' };
			await db.addDevice(defDev);
			deviceList = [defDev];
			const bid = uuid();
			await db.addProject({ id: bid, deviceId: defDev.id, name: 'Main Board', sortMode:'none' });
		}

		currentDeviceId = deviceList[0].id;
		localStorage.setItem('pcb_dev_id', currentDeviceId);

		updateDeviceDropdown();
		await loadDeviceBoms();
		resetStickyEditor();
	} catch (e) {
		console.error("Delete failed:", e);
		alert("Error deleting device: " + e.message);
	}
}

// --- COMPONENTS ---
async function addPart() {
	const id = document.getElementById('inp-id').value;
	const label = document.getElementById('inp-label').value.toUpperCase().trim();
	const value = document.getElementById('inp-value').value;
	const desc = document.getElementById('inp-desc').value;
	const x = document.getElementById('inp-x').value;
	const y = document.getElementById('inp-y').value;
	const imgId = document.getElementById('inp-img-id').value;

	if(!label) return alert("Ref required");

	// Check collision
	const collision = bomData.find(c => c.label === label && c.id !== id);
	if (collision) {
		if(!await confirmAction("Reference exists. Overwrite?", "Overwrite")) return;
		await db.deleteComponent(collision.id);
	}

	// Save
	const c = { id: id || uuid(), boardId: currentBomId, label, value, desc };
	if(x && y && imgId) { c.x = parseFloat(x); c.y = parseFloat(y); c.imgId = imgId; }

	await db.addComponent(c);
	document.getElementById('inp-id').value = c.id;
	await loadProjectData();

	if(returnToMap) { switchView('map'); returnToMap = false; }
	else {
		// Optional: blink the button or give feedback
		const btn = document.querySelector('.btn-add');
		const origText = btn.innerText;
		btn.innerText = "Saved!";
		setTimeout(() => btn.innerText = origText, 1000);
	}
}

async function deleteCurrentPart() {
	const id = document.getElementById('inp-id').value;

	// Safety: Don't do anything if no component is selected (e.g. creating new)
	if (!id) return;

	if (await confirmAction("Delete this component?", "Delete")) {
		await db.deleteComponent(id);
		await loadProjectData();
		resetStickyEditor(); // Clear the form/images after deletion
	}
}

// --- IMPORT / EXPORT ---
// Device Export
async function exportDeviceZIP() {
	if(!window.JSZip) return alert("JSZip required.");
	if(!currentDeviceId) return;

	const dev = deviceList.find(d => d.id === currentDeviceId);
	const boms = await db.getProjectsByDevice(currentDeviceId);
	const zip = new JSZip();

	// Fetch ALL nets once (since we don't have an index, we filter in JS)
	const allNets = await db.getNets();

	// 1. Generate README
	const readmeContent = `PCB ReTrace Data Export
Type: Full Device Backup (${dev.name})
Generated by: pcb.etaras.com
Date: ${new Date().toISOString()}

HOW TO USE:
1. Go to https://pcb.etaras.com/studio.html
2. Click "Import Device" or drag and drop this ZIP file into the tool.
`;
	zip.file("README.txt", readmeContent);

	// 2. Generate Manifest
	const manifest = {
		device: dev,
		version: DB_VER,
		source: "pcb.etaras.com",
		boards: []
	};

	const imgFolder = zip.folder("images");

	for (const bom of boms) {
		const comps = await db.getComponents(bom.id);
		const imgs = await db.getImages(bom.id);

		// Filter nets for this specific board
		const boardNets = allNets.filter(n => n.projectId === bom.id);

		const overlapsMap = new Map();
		for(const img of imgs) {
			const ovs = await db.getOverlapsForImage(img.id);
			ovs.forEach(o => overlapsMap.set(o.id, o));
		}

		const cleanComps = comps.map(c => { const { boardId, ...rest } = c; return rest; });
		const imgMeta = imgs.map(img => ({ id: img.id, name: img.name, type: 'image/jpeg' }));

		manifest.boards.push({
			meta: bom,
			components: cleanComps,
			images: imgMeta,
			overlaps: Array.from(overlapsMap.values()),
			nets: boardNets // Add Nets to manifest
		});

		// Image Loop
		for (const img of imgs) {
			let blobToSave = img.blob;
			if (img.blob.type !== 'image/jpeg') {
				const bmp = await createImageBitmap(img.blob);
				const canvas = document.createElement('canvas');
				canvas.width = bmp.width;
				canvas.height = bmp.height;
				canvas.getContext('2d').drawImage(bmp, 0, 0);
				bmp.close();
				blobToSave = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
			}
			imgFolder.file(`${img.id}.jpg`, blobToSave);
		}
	}

	zip.file("device.json", JSON.stringify(manifest, null, 2));
	zip.generateAsync({type:"blob"}).then(c => dl(c, `${dev.name}_Backup.zip`, 'application/zip'));
}

function isValidBoardData(data) {
	// 1. Root Object check
	if (!data || typeof data !== 'object') return false;

	// 2. Meta Object check
	if (!data.meta || typeof data.meta !== 'object') return false;
	// ID must be a string and not empty
	if (typeof data.meta.id !== 'string' || !data.meta.id.trim()) return false;
	// Name must be a string (can be empty, but must exist)
	if (typeof data.meta.name !== 'string') return false;

	// 3. Components Array check
	if (!Array.isArray(data.components)) return false;

	// 4. Images Array check (optional but must be array if present)
	if (data.images && !Array.isArray(data.images)) return false;

	return true;
}

function isValidDeviceManifest(data) {
	if (!data || typeof data !== 'object') return false;

	// 1. Device Object check
	if (!data.device || typeof data.device !== 'object') return false;
	if (typeof data.device.id !== 'string' || !data.device.id.trim()) return false;
	if (typeof data.device.name !== 'string') return false;

	// 2. Boards Array check
	if (!Array.isArray(data.boards)) return false;

	// 3. Version check (optional warning could be added here, but structural check is pass/fail)
	return true;
}

function isValidLegacyData(data) {
	// Case A: Top-level Array of objects
	if (Array.isArray(data)) return true;

	// Case B: Object with 'components' or 'data' array
	if (data && typeof data === 'object') {
		return Array.isArray(data.components) || Array.isArray(data.data);
	}
	return false;
}

async function importFile(f) {
	if(!f) return;
	const name = f.name.toLowerCase();

	// 1. ZIP Import (Device Backup or Board Export)
	if(name.endsWith('.zip')) {
		await processZIP(f);
		return;
	}

	// 2. JSON Import (Metadata only)
	if(name.endsWith('.json')) {
		const r = new FileReader();
		r.onload = async e => {
			try {
				const json = JSON.parse(e.target.result);

				if (isValidBoardData(json)) {
					if (!currentDeviceId) return alert("Select a Device first.");
					if(confirm(`Import Board "${json.meta.name}" from JSON?`)) {
						json.meta.deviceId = currentDeviceId;
						await processImportData(json, null);
					}
					return;
				}

				if (isValidDeviceManifest(json)) {
					alert("Device Manifests should be imported via ZIP to include images.\nImporting metadata only.");
					if(confirm("Proceed with metadata-only import?")) {
						await restoreDevice(json, null);
					}
					return;
				}

				if (isValidLegacyData(json)) {
					if(confirm("Detected Legacy BOM format. Import into current board?")) {
						await processLegacyImport(json);
					}
					return;
				}
				throw new Error("JSON structure does not match known schemas.");
			} catch(e) {
				console.error(e);
				alert("Invalid JSON: " + e.message);
			}
		};
		r.readAsText(f);
		return;
	}

	// 3. Image Import (Drag & Drop -> Open Editor)
	if(/\.(jpg|jpeg|png|webp)$/i.test(name)) {
		// SAFETY: Ensure a board is currently active
		if(!currentBomId) {
			alert("Cannot import image: No board selected.\nPlease select or create a board first.");
			return;
		}

		// Read file as DataURL to pass to the Editor
		const r = new FileReader();
		r.onload = e => {
			if (typeof ImageImporter !== 'undefined') {
				// Pre-fill the name
				if(ImageImporter.nameInput) {
					ImageImporter.nameInput.value = f.name.replace(/\.[^/.]+$/, "");
				}
				// Open the Modal
				ImageImporter.loadImage(e.target.result);
			} else {
				// Fallback if UI not loaded (unlikely)
				if(confirm(`Import image "${f.name}"?`)) {
					saveProcessedImageToDB(f, f.name);
				}
			}
		};
		r.readAsDataURL(f);
		return;
	}
}

// Button Handler (keeps input element logic)
function handleImport(i) {
	const f = i.files[0];
	if(f) importFile(f);
	i.value = ''; // Reset input so same file can be selected again
}

function setupDragDrop() {
	const zone = document.body;
	let dragCounter = 0; // Fixes flickering when dragging over child elements

	// 1. Drag Enter
	zone.addEventListener('dragenter', e => {
		e.preventDefault();
		dragCounter++;
		zone.classList.add('drag-active');
	});

	// 2. Drag Leave
	zone.addEventListener('dragleave', e => {
		e.preventDefault();
		dragCounter--;
		if(dragCounter === 0) zone.classList.remove('drag-active');
	});

	// 3. Drag Over (Required to allow dropping)
	zone.addEventListener('dragover', e => e.preventDefault());

	// 4. Drop
	zone.addEventListener('drop', async e => {
		e.preventDefault();
		dragCounter = 0;
		zone.classList.remove('drag-active');

		if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
			// Process only the first file
			await importFile(e.dataTransfer.files[0]);
		}
	});
}

async function processZIP(file) {
	if(!window.JSZip) return alert("JSZip library not loaded.");

	try {
		const zip = await JSZip.loadAsync(file);
		let recognized = false;

		// CASE A: Device Backup
		if (zip.file("device.json")) {
			const content = await zip.file("device.json").async("string");
			let manifest;
			try { manifest = JSON.parse(content); } catch(e) { throw new Error("device.json is corrupt"); }

			// STRICT CHECK
			if (isValidDeviceManifest(manifest)) {
				recognized = true;
				const vMsg = manifest.version ? `(v${manifest.version})` : '';
				const sMsg = manifest.source ? `\nSource: ${manifest.source}` : '';

				if(confirm(`Restore Device: "${manifest.device.name}" ${vMsg}?${sMsg}\n\nThis will merge boards and overwrite existing components.`)) {
					await restoreDevice(manifest, zip);
				}
			} else {
				throw new Error("ZIP contains device.json, but it is missing required fields (id, name, boards).");
			}
		}

		// CASE B: Single Board Backup
		else if (zip.file("bom.json")) {
			const content = await zip.file("bom.json").async("string");
			let data;
			try { data = JSON.parse(content); } catch(e) { throw new Error("bom.json is corrupt"); }

			// STRICT CHECK
			if (isValidBoardData(data)) {
				recognized = true;
				if (!currentDeviceId) {
					alert("Please select or create a Device first.");
					return;
				}
				if(confirm(`Import Board: "${data.meta.name}" into current Device?`)) {
					data.meta.deviceId = currentDeviceId;
					await processImportData(data, zip);
				}
			} else {
				throw new Error("ZIP contains bom.json, but it is missing required fields (id, meta, components).");
			}
		}

		if (!recognized) {
			alert("Unrecognized ZIP format.\n\nExpected 'device.json' or 'bom.json' with valid structure.");
		}

	} catch(e) {
		console.error(e);
		alert("Import Failed: " + e.message);
	}
}

async function restoreDevice(manifest, zip) {
	const devId = manifest.device.id;
	const existingDev = deviceList.find(d => d.id === devId);
	if (!existingDev) {
		await db.addDevice(manifest.device);
	}

	// --- PRUNING PHASE 1: BOARDS ---
	const localBoards = await db.getProjectsByDevice(devId);
	const manifestBoardIds = new Set(manifest.boards.map(b => b.meta.id));
	for (const lb of localBoards) {
		if (!manifestBoardIds.has(lb.id)) {
			await db.deleteProject(lb.id);
			// Note: deleteProject doesn't currently delete Nets automatically in the DB class
			// We should ideally clean them up, but for now we focus on the restore logic.
			console.log(`Pruned Board: ${lb.name}`);
		}
	}

	const imgFolder = zip.folder("images");
	let updatedBoards = 0;
	let mergedBoards = 0;

	for (const boardData of manifest.boards) {
		const boardId = boardData.meta.id;
		const localBoard = await db.getProject(boardId);

		// Timestamp Logic
		const incomingTime = boardData.meta.lastModified || 0;
		const localTime = localBoard ? (localBoard.lastModified || 0) : -1;
		const isNewer = incomingTime > localTime;

		if (isNewer) {
			// Update Meta
			boardData.meta.deviceId = devId;
			await db.addProject(boardData.meta);
			if(localBoard) updatedBoards++;

			// --- PRUNING PHASE 2: CONTENT ---
			// 1. Prune Components
			const localComps = await db.getComponents(boardId);
			const importCompIds = new Set(boardData.components.map(c => c.id));
			for(const lc of localComps) {
				if(!importCompIds.has(lc.id)) await db.deleteComponent(lc.id);
			}

			// 2. Prune Images
			const localImages = await db.getImages(boardId);
			const importImgIds = new Set(boardData.images.map(i => i.id));
			for(const li of localImages) {
				if(!importImgIds.has(li.id)) await db.deleteImage(li.id);
			}

			// 3. Prune Overlaps
			if(localImages.length > 0) {
				const boardOverlapIds = new Set();
				for(const li of localImages) {
					const ovs = await db.getOverlapsForImage(li.id);
					ovs.forEach(o => boardOverlapIds.add(o.id));
				}
				const importOvIds = new Set((boardData.overlaps || []).map(o => o.id));
				const tx = db.db.transaction('overlappedImages', 'readwrite');
				const store = tx.objectStore('overlappedImages');
				boardOverlapIds.forEach(ovid => {
					if(!importOvIds.has(ovid)) store.delete(ovid);
				});
			}

			// 4. Prune Nets [NEW]
			const allNets = await db.getNets();
			const localNets = allNets.filter(n => n.projectId === boardId);
			const importNetIds = new Set((boardData.nets || []).map(n => n.id));
			for(const ln of localNets) {
				if(!importNetIds.has(ln.id)) await db.deleteNet(ln.id);
			}

		} else {
			mergedBoards++;
		}

		// --- UPSERT PHASE ---

		// Images (unchanged logic...)
		if (imgFolder && boardData.images) {
			for (const im of boardData.images) {
				if (!isNewer) {
					const existingImg = await db.getImage(im.id);
					if (existingImg) continue;
				}
				const cleanStoredId = im.id.split('/').pop();
				let filename = cleanStoredId + ".jpg";
				let file = imgFolder.file(filename);
				if (!file) file = zip.file("images/" + filename);
				if (!file) {
					const cleanExt = (im.type.split('/')[1] || 'png');
					filename = cleanStoredId + "." + cleanExt;
					file = imgFolder.file(filename);
					if (!file) file = zip.file("images/" + filename);
				}
				if (file) {
					const blob = await file.async("blob");
					const cleanName = im.name.replace(/\.[^/.]+$/, "");
					await db.addImage({ id: im.id, boardId: boardId, blob, name: cleanName });
				}
			}
		}

		// Components
		for (const c of boardData.components) {
			c.boardId = boardId;
			if (isNewer) {
				await db.addComponent(c);
			} else {
				const existingC = await db._tx('components', 'readonly', s => s.get(c.id));
				if (!existingC) await db.addComponent(c);
			}
		}

		// Overlaps
		if (boardData.overlaps) {
			for (const ov of boardData.overlaps) {
				if (isNewer) {
					await db.addOverlap(ov);
				} else {
					const existingOv = await db._tx('overlappedImages', 'readonly', s => s.get(ov.id));
					if (!existingOv) await db.addOverlap(ov);
				}
			}
		}

		// Nets [NEW]
		if (boardData.nets) {
			for (const net of boardData.nets) {
				// Ensure correct association
				net.projectId = boardId;
				if (isNewer) {
					await db.addNet(net);
				} else {
					const existingNet = await db._tx('nets', 'readonly', s => s.get(net.id));
					if (!existingNet) await db.addNet(net);
				}
			}
		}
	}

	deviceList = await db.getDevices();
	currentDeviceId = devId;
	updateDeviceDropdown();
	await loadDeviceBoms();
}

async function processImportData(data, zipObj) {
	const boardId = data.meta.id;
	const localBoard = await db.getProject(boardId);

	const incomingTime = data.meta.lastModified || 0;
	const localTime = localBoard ? (localBoard.lastModified || 0) : -1;
	const isNewer = incomingTime > localTime;

	if (isNewer) {
		// Update Meta
		data.meta.deviceId = localBoard ? localBoard.deviceId : currentDeviceId;
		await db.addProject(data.meta);

		// --- PRUNING PHASE ---

		// 1. Components
		const localComps = await db.getComponents(boardId);
		const importCompIds = new Set(data.components.map(c => c.id));
		for(const lc of localComps) {
			if(!importCompIds.has(lc.id)) await db.deleteComponent(lc.id);
		}

		// 2. Images
		const localImages = await db.getImages(boardId);
		const importImgIds = new Set((data.images || []).map(i => i.id));
		for(const li of localImages) {
			if(!importImgIds.has(li.id)) await db.deleteImage(li.id);
		}

		// 3. Overlaps
		if(localImages.length > 0) {
			const boardOverlapIds = new Set();
			for(const li of localImages) {
				const ovs = await db.getOverlapsForImage(li.id);
				ovs.forEach(o => boardOverlapIds.add(o.id));
			}
			const importOvIds = new Set((data.overlaps || []).map(o => o.id));
			const tx = db.db.transaction('overlappedImages', 'readwrite');
			const store = tx.objectStore('overlappedImages');
			boardOverlapIds.forEach(ovid => {
				if(!importOvIds.has(ovid)) store.delete(ovid);
			});
		}

		// 4. Nets [NEW]
		const allNets = await db.getNets();
		const localNets = allNets.filter(n => n.projectId === boardId);
		const importNetIds = new Set((data.nets || []).map(n => n.id));
		for(const ln of localNets) {
			if(!importNetIds.has(ln.id)) await db.deleteNet(ln.id);
		}

	} else {
		console.log("Import is older/same. Merging missing items only.");
	}

	// --- UPSERT PHASE ---

	// Images (unchanged logic...)
	if (zipObj && data.images) {
		const imgFolder = zipObj.folder("images");
		if (imgFolder) {
			const imgFiles = [];
			imgFolder.forEach((path, file) => imgFiles.push(file));

			for(const f of imgFiles) {
				const fileName = f.name.split('/').pop();
				const idFromName = fileName.split('.')[0];

				const metaImg = data.images.find(x => x.id === idFromName || x.id.endsWith(idFromName));
				const finalId = metaImg ? metaImg.id : idFromName;
				const finalName = metaImg ? metaImg.name.replace(/\.[^/.]+$/, "") : fileName;
				const mime = metaImg ? metaImg.type : 'image/jpeg';

				if (!isNewer) {
					const existing = await db.getImage(finalId);
					if (existing) continue;
				}

				const rawBlob = await f.async("blob");
				const blob = new Blob([rawBlob], { type: mime });

				await db.addImage({ id: finalId, boardId: boardId, blob, name: finalName });
			}
		}
	}

	// Components
	for(const c of data.components) {
		c.boardId = boardId;
		if (isNewer) {
			await db.addComponent(c);
		} else {
			const existing = await db._tx('components', 'readonly', s => s.get(c.id));
			if (!existing) await db.addComponent(c);
		}
	}

	// Overlaps
	if (data.overlaps) {
		for (const ov of data.overlaps) {
			if (isNewer) {
				await db.addOverlap(ov);
			} else {
				const existing = await db._tx('overlappedImages', 'readonly', s => s.get(ov.id));
				if (!existing) await db.addOverlap(ov);
			}
		}
	}

	// Nets [NEW]
	if (data.nets) {
		for (const net of data.nets) {
			net.projectId = boardId;
			if (isNewer) {
				await db.addNet(net);
			} else {
				const existing = await db._tx('nets', 'readonly', s => s.get(net.id));
				if (!existing) await db.addNet(net);
			}
		}
	}

	await loadDeviceBoms();
}

async function processLegacyImport(b) {
	if (!currentBomId) return alert("Create/Select a board first.");
	for(const c of (b.components || b.data)) { c.id = uuid(); c.boardId = currentBomId; await db.addComponent(c); }
	await loadProjectData();
}

// Board Export
async function exportZIP() {
	if(!window.JSZip) return;
	const zip = new JSZip();
	const meta = bomList.find(x=>x.id===currentBomId);
	const images = await db.getImages(currentBomId);

	// Fetch and filter Nets
	const allNets = await db.getNets();
	const boardNets = allNets.filter(n => n.projectId === currentBomId);

	const overlapsMap = new Map();
	for(const img of images) {
		const ovs = await db.getOverlapsForImage(img.id);
		ovs.forEach(o => overlapsMap.set(o.id, o));
	}
	const overlaps = Array.from(overlapsMap.values());

	const imgMeta = images.map(i => ({ id: i.id, name: i.name, type: 'image/jpeg' }));
	const cleanComps = bomData.map(c => { const { boardId, ...rest } = c; return rest; });

	// 1. Generate README
	const readmeContent = `PCB ReTrace Data Export
Type: Single Board (${meta.name})
Generated by: pcb.etaras.com
Date: ${new Date().toISOString()}

HOW TO USE:
1. Go to https://pcb.etaras.com/studio.html
2. Select or Create a Device.
3. Click "Import Board" or drag and drop this ZIP file into the component list.
`;
	zip.file("README.txt", readmeContent);

	// 2. Generate JSON
	const data = {
		meta,
		components: cleanComps,
		images: imgMeta,
		overlaps: overlaps,
		nets: boardNets, // Add Nets
		version: DB_VER,
		source: "pcb.etaras.com"
	};

	zip.file("bom.json", JSON.stringify(data, null, 2));

	const imgFolder = zip.folder("images");

	// Image Loop
	for (const img of images) {
		let blobToSave = img.blob;
		if (img.blob.type !== 'image/jpeg') {
			const bmp = await createImageBitmap(img.blob);
			const canvas = document.createElement('canvas');
			canvas.width = bmp.width;
			canvas.height = bmp.height;
			canvas.getContext('2d').drawImage(bmp, 0, 0);
			bmp.close();
			blobToSave = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
		}
		imgFolder.file(img.id + ".jpg", blobToSave);
	}

	zip.generateAsync({type:"blob"}).then(c => dl(c, meta.name + "_Board.zip", "application/zip"));
}

function exportCSV() {
	const meta = bomList.find(p => p.id === currentBomId);
	const view = getSortedView();
	let csv = "Reference,Value,Description\n";
	view.forEach(r => csv += `${r.label},${r.value},"${(r.desc||'').replace(/"/g,'""')}"\n`);
	const blob = new Blob([csv], { type: 'text/csv' });
	const url = window.URL.createObjectURL(blob);
	const a = document.createElement('a'); a.href = url; a.download = `${meta.name}_BOM.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function dl(c,n,t){ const b=(c instanceof Blob)?c:new Blob([c],{type:t}); const u=window.URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download=n; document.body.appendChild(a); a.click(); document.body.removeChild(a); }

// --- UI HELPERS ---
// Global Confirmation Helper (Promise-based)
function confirmAction(message, btnText = "Confirm") {
	return new Promise((resolve) => {
		const modal = document.getElementById('confirmation-modal');
		const msgEl = document.getElementById('confirm-msg');
		const okBtn = document.getElementById('confirm-btn-ok');
		const cancelBtn = document.getElementById('confirm-btn-cancel');

		msgEl.innerText = message;
		okBtn.innerText = btnText;

		// Cleanup old handlers by reassigning
		okBtn.onclick = () => {
			modal.style.display = 'none';
			resolve(true);
		};

		cancelBtn.onclick = () => {
			modal.style.display = 'none';
			resolve(false);
		};

		modal.style.display = 'flex';
		cancelBtn.focus(); // Default focus on Cancel
	});
}

function switchView(v) {
	// UI Toggles
	document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
	document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));

	// Button Active State
	const btn = document.getElementById(`tab-${v}`);
	if (btn) btn.classList.add('active');

	// View Active State
	const view = document.getElementById(`view-${v}`);
	if (view) view.classList.add('active');

	// View Specific Initialization
	if (v === 'map') {
		if(currentImgId) {
			if(!document.getElementById('map-content').querySelector('.pcb-image')) showImage(currentImgId);
			else { setTimeout(() => { if(mapState.scale === 1 && mapState.x === 0 && mapState.y === 0) fitMap(); renderPins(); }, 50); }
		}
	}
	else if (v === 'nets') {
		if(window.netManager) window.netManager.render();
	}
	else if (v === 'inspect') {
		if(window.inspector) window.inspector.init();
	}
	// 'list' needs no specific init
}

function resetStickyEditor() {
	document.getElementById('inp-id').value = '';
	document.getElementById('inp-label').value = '';
	document.getElementById('inp-value').value = '';
	document.getElementById('inp-desc').value = '';
	document.getElementById('inp-x').value = '';
	document.getElementById('inp-y').value = '';
	document.getElementById('inp-img-id').value = '';
	document.getElementById('new-part-tool-container').innerHTML = '';
	document.getElementById('inline-thumbs').innerHTML = '';
	if(spyglass) spyglass.clear();
}
function parseLabel(l) { const m=l.toUpperCase().match(/^([A-Z]+)(\d+)(.*)$/); return m?{valid:true,prefix:m[1],num:parseInt(m[2])}:{valid:false}; }
async function changeSortMode() { sortMode=document.getElementById('sort-select').value; const m=bomList.find(x=>x.id===currentBomId); if(m){ m.sortMode=sortMode; await db.addProject(m); renderList(); } }
function getSortedView() {
	let view = bomData.map((item, index) => ({ ...item, dataIndex: index }));
	if (sortMode === 'none') return view;
	view.sort((a, b) => {
		const pa=parseLabel(a.label), pb=parseLabel(b.label);
		if (!pa.valid || !pb.valid) return a.label.localeCompare(b.label);
		if (sortMode === 'std') return pa.prefix!==pb.prefix ? pa.prefix.localeCompare(pb.prefix) : pa.num-pb.num;
		return pa.num!==pb.num ? pa.num-pb.num : pa.prefix.localeCompare(pb.prefix);
	});
	return view;
}
function renderList() {
	const tb = document.getElementById('bom-body'); tb.innerHTML='';
	let view = getSortedView();
	if(view.length===0) tb.innerHTML=`<tr><td colspan="4" class="empty-state" style="padding:2rem">Empty BOM</td></tr>`;
	view.forEach(p => {
		const pinIcon = (p.x !== undefined) ? `<span style="cursor:pointer" onclick="locateComponent('${p.imgId}', ${p.x}, ${p.y}); event.stopPropagation();">🎯</span>` : '';
		const tr = document.createElement('tr');

		// [NEW] Assign ID for lookup
		tr.dataset.id = p.id;

		tr.onclick = (e) => {
			 if(e.target.tagName==='BUTTON' || e.target.closest('button')) return;
			 fillFormFromData(p);
			 document.querySelectorAll('tbody tr').forEach(x=>x.classList.remove('editing'));
			 tr.classList.add('editing');
		};
		const tools = getToolButtonsHtml(p.label, p.dataIndex);
		tr.innerHTML = `<td><strong>${pinIcon} ${p.label}</strong></td>
			<td><div class="val-cell"><span class="val-text">${p.value||'-'}</span><div class="tool-group">${tools}<button class="tool-btn copy-btn" onclick="copyPartToForm(${p.dataIndex})" title="Copy">📄</button></div></div></td>
			<td>${p.desc}</td>`;
		tb.appendChild(tr);
	});
	// Check if new connections were made, update overlap cache if so (from modal)
	if(currentImgId) updateOverlapCache().then(() => {});
}
function toggleExport(e) { e.stopPropagation(); const el = document.getElementById('export-dropdown'); const isShown = el.style.display === 'block'; document.querySelectorAll('.dropdown-content').forEach(d => d.style.display = 'none'); el.style.display = isShown ? 'none' : 'block'; }
window.addEventListener('click', () => document.querySelectorAll('.dropdown-content').forEach(d => d.style.display = 'none'));
async function removePart(idx) {
	if(await confirmAction("Remove this component?", "Remove")) {
		await db.deleteComponent(bomData[idx].id);
		await loadProjectData();
	}
}
async function clearCurrentBom() {
	if(await confirmAction("Clear ALL components from this board?", "Clear All")) {
		await db.clearComponents(currentBomId);
		await loadProjectData();
		resetStickyEditor();
	}
}
async function deleteBom() {
	if(bomList.length < 1) return;
	if(await confirmAction("Delete this Board and all its content?", "Delete Board")){
		await db.deleteProject(currentBomId);
		history.back();
		await loadDeviceBoms();
		resetStickyEditor();
	}
}
function checkToolHint(v) { document.getElementById('new-part-tool-container').innerHTML=getToolButtonsHtml(v,'new'); }
function getToolButtonsHtml(lbl, idx) {
	if(!lbl)return ''; const p=lbl.charAt(0).toUpperCase(), ts=TOOL_REGISTRY[p]; if(!ts)return '';
	const iStr = (idx==='new')?"'new'":idx; let h='';
	const cnt = ts.length > MAX_DIRECT_TOOLS ? MAX_DIRECT_TOOLS-1 : ts.length;
	for(let i=0;i<cnt;i++) h+=`<button class="tool-btn" onclick="openToolD(${iStr},'${ts[i].url}','${ts[i].title}')">${ts[i].icon}</button>`;
	if(ts.length>MAX_DIRECT_TOOLS) h+=`<button class="tool-btn more-btn" onclick="openToolS(${iStr})">•••</button>`;
	return `<div class="tool-group">${h}</div>`;
}

// --- TOOLS ---
const modal=document.getElementById('tool-modal'), iframe=document.getElementById('tool-frame'), toolTitle=document.getElementById('tool-title');

async function openToolD(idx, url, tit) {
	editingIndex = idx;
	toolTitle.innerText = tit;
	document.getElementById('tool-selector').style.display = 'none';

	iframe.style.display = 'none';
	modal.style.display = 'flex';

	let d = (idx === 'new')
		? { v: document.getElementById('inp-value').value, d: document.getElementById('inp-desc').value, comp: null }
		: { v: bomData[idx].value, d: bomData[idx].desc, comp: bomData[idx] };

	let srcX = null, srcY = null, srcImgId = null;

	if (idx !== 'new' && d.comp) {
		srcImgId = d.comp.imgId; srcX = d.comp.x; srcY = d.comp.y;
	} else if (idx === 'new') {
		const iid = document.getElementById('inp-img-id').value;
		if (iid) {
			srcImgId = iid;
			srcX = parseFloat(document.getElementById('inp-x').value);
			srcY = parseFloat(document.getElementById('inp-y').value);
		}
	}

	const views = [];
	const transferables = [];

	if (srcImgId && srcX !== null && srcY !== null) {
		try {
			const imgRec = await db.getImage(srcImgId);
			if (imgRec && imgRec.blob) {
				const bmp = await createImageBitmap(imgRec.blob);
				views.push({ name: imgRec.name + " (Main)", bitmap: bmp, x: srcX, y: srcY, isMain: true });
				transferables.push(bmp);

				// USE HELPER for Inferred Views
				const paths = await ImageGraph.solvePaths(srcImgId, cvManager, db);

				for (const pData of paths) {
					const pt = cvManager.projectPoint(srcX, srcY, pData.H);
					if (pt) {
						const targetRec = await db.getImage(pData.id);
						if(targetRec) {
							const tBmp = await createImageBitmap(targetRec.blob);
							if (pt.x > 0 && pt.y > 0 && pt.x < tBmp.width && pt.y < tBmp.height) {
								views.push({ name: targetRec.name, bitmap: tBmp, x: pt.x, y: pt.y, isMain: false, imgId: pData.id });
								transferables.push(tBmp);
							} else {
								tBmp.close();
							}
						}
					}
				}
			}
		} catch (e) { console.error("Error generating views:", e); }
	}

	const loadHandler = () => {
		iframe.style.display = 'block';
		const msg = { type: 'INIT_TOOL', value: d.v, description: d.d, views: views };
		iframe.contentWindow.postMessage(msg, '*', transferables);
	};

	iframe.removeEventListener('load', loadHandler);
	iframe.addEventListener('load', loadHandler, { once: true });

	const finalUrl = url + "?embed=true";

	// --- Use location.replace to avoid history pollution ---
	if (iframe.contentWindow && iframe.contentWindow.location) {
		try {
			iframe.contentWindow.location.replace(finalUrl);
		} catch(e) {
			// Fallback for first load or cross-origin issues (though local)
			iframe.src = finalUrl;
		}
	} else {
		iframe.src = finalUrl;
	}
}

function openToolS(idx) {
	editingIndex=idx; const lbl=(idx==='new')?document.getElementById('inp-label').value:bomData[idx].label; const ts=TOOL_REGISTRY[lbl.charAt(0).toUpperCase()];
	toolTitle.innerText="Select Tool"; iframe.style.display='none'; document.getElementById('tool-selector').style.display='flex'; modal.style.display='flex';
	const g=document.getElementById('selector-grid'); g.innerHTML='';
	ts.forEach(t=>{ const c=document.createElement('div'); c.className='tool-card'; c.innerHTML=`<div class="tool-card-icon">${t.icon}</div><div class="tool-card-title">${t.title}</div>`; c.onclick=()=>openToolD(idx,t.url,t.title); g.appendChild(c); });
}
function closeTool(){ modal.style.display='none'; iframe.src=''; }
window.addEventListener('message', async e=>{
	if(e.data.type==='COMPONENT_UPDATE') {
		if(editingIndex==='new') { document.getElementById('inp-value').value=e.data.value; if(e.data.description)document.getElementById('inp-desc').value=e.data.description; }
		else { const c=bomData[editingIndex]; c.value=e.data.value; if(e.data.description)c.desc=e.data.description; await db.addComponent(c); await loadProjectData(); }
		closeTool();
	}
	// 2. Handle Promotion (Swap Source Image)
	else if (e.data.type === 'PROMOTE_VIEW') {
		if (editingIndex !== -1 && editingIndex !== 'new') {
			const c = bomData[editingIndex];
			c.imgId = e.data.imgId; // Switch the source image ID
			c.x = e.data.x;
			c.y = e.data.y;
			await db.addComponent(c);
			await loadProjectData(); // Refresh Map/List
			closeTool(); // Close tool to force refresh of state
		}
	}

	// 3. Handle Position Adjustment (Drag in Spyglass)
	else if (e.data.type === 'UPDATE_POS') {
		if (editingIndex !== -1 && editingIndex !== 'new') {
			const c = bomData[editingIndex];
			c.x = e.data.x;
			c.y = e.data.y;
			await db.addComponent(c);
			// Note: We don't reloadProjectData() here to keep the UI smooth while dragging
		}
	}
});

// --- SPYGLASS & MAP (ENHANCED) ---
async function showImage(id) {
	currentImgId = id;
	const imgSel = document.getElementById('image-select');
	if(imgSel && imgSel.value !== id) imgSel.value = id;
	const imgObj = bomImages.find(i => i.id === id);
	if(!imgObj) return;
	const url = URL.createObjectURL(imgObj.blob);
	const currentImg = document.getElementById('map-content').querySelector('.pcb-image');
	if(!currentImg || currentImg.dataset.id !== id) {
		 document.getElementById('map-content').innerHTML = `<img src="${url}" data-id="${id}" class="pcb-image">`;
		 const newImg = document.getElementById('map-content').querySelector('.pcb-image');
		 newImg.onload = () => fitMap();
	}
	await updateOverlapCache(); // LOAD OVERLAPS
	renderPins();
}
function fitMap() {
	if(skipNextFit) { skipNextFit = false; return; }
	const img = document.getElementById('map-content').querySelector('.pcb-image');
	if(!img) return;
	if(img.naturalWidth === 0) { img.onload = () => fitMap(); return; }
	const viewport = document.getElementById('map-viewport');
	const vw = viewport.clientWidth; const vh = viewport.clientHeight;
	if (vw === 0 || vh === 0) return;
	const scale = Math.min(vw/img.naturalWidth, vh/img.naturalHeight);
	mapState = { scale: scale, x: (vw - img.naturalWidth*scale)/2, y: (vh - img.naturalHeight*scale)/2, isDragging: false };
	updateTransform();
}
function switchImage() { showImage(document.getElementById('image-select').value); setTimeout(fitMap, 50); }
async function locateComponent(imgId, x, y) {
	if (!imgId || x === undefined || y === undefined) return;

	// 1. Switch to Map Tab
	switchView('map');

	// 2. Load Image (Prevent fitMap from resetting our zoom)
	if (currentImgId !== imgId) {
		skipNextFit = true;
		await showImage(imgId);
	}

	// 3. Calculate Center & Zoom
	const viewport = document.getElementById('map-viewport');
	const vw = viewport.clientWidth || window.innerWidth;
	const vh = viewport.clientHeight || window.innerHeight;
	const targetScale = 4; // Max/High Zoom

	mapState = {
		scale: targetScale,
		x: (vw / 2) - (x * targetScale),
		y: (vh / 2) - (y * targetScale),
		isDragging: false, startX:0, startY:0
	};

	updateTransform();
	renderPins();
}

/**
 * Saves a pre-processed image blob (from the Import Modal) to the database.
 * This bypasses the file picker and allows for standardized names/types.
 */
async function saveProcessedImageToDB(blob, name) {
	if (!currentBomId) { alert("Please select a Board first."); return; }

	const id = uuid();
	const newImage = { id: id, boardId: currentBomId, name: name, blob: blob, created: Date.now() };

	try {
		await db.addImage(newImage);
		await loadProjectData();

		const imgSelect = document.getElementById('image-select');
		if(imgSelect) { imgSelect.value = id; switchImage(); }
		switchView('map');

		await autoStitchNewImage(id);

	} catch (e) {
		console.error("Failed to save image:", e);
		alert("Error saving image to database.");
	}
}

// EXPOSE TO GLOBAL SCOPE so the HTML modal can call it
window.saveProcessedImageToDB = saveProcessedImageToDB;

async function uploadImage(input) {
	const file = input.files[0]; if(!file) return;
	const name = await requestInput("Upload Image", "Image Name", file.name);

	if(!name) return;

	const id = uuid(); // Capture ID to use later
	await db.addImage({ id: id, boardId: currentBomId, blob: file, name: name });

	await loadProjectData();
	switchView('map');

	await autoStitchNewImage(id);
}

// Open the Image Settings Modal
function openImageSettings() {
	if(!currentImgId) return alert("No image selected");

	const img = bomImages.find(i => i.id === currentImgId);
	if(!img) return;

	document.getElementById('edit-image-name').value = img.name;
	document.getElementById('image-settings-modal').style.display = 'flex';
}

// Save Rename Changes
async function saveImageSettings() {
	if(!currentImgId) return;

	const newName = document.getElementById('edit-image-name').value.trim();
	if(!newName) return alert("Name cannot be empty");

	const img = bomImages.find(i => i.id === currentImgId);

	// Only update DB if changed
	if(img.name !== newName) {
		img.name = newName;
		await db.addImage(img); // Upsert to DB

		// Update UI Dropdown immediately without full reload
		const sel = document.getElementById('image-select');
		const opt = sel.querySelector(`option[value="${currentImgId}"]`);
		if(opt) opt.innerText = newName;

		// Update connections modal source name if it's open or cached
		const connName = document.getElementById('conn-src-name');
		if(connName) connName.innerText = newName;
	}

	history.back();
}

// Delete Image (Close modal on success)
async function deleteCurrentImage() {
	if(!currentImgId) return;

	const usageCount = bomData.filter(c => c.imgId === currentImgId).length;
	if (usageCount > 0) {
		alert(`Cannot delete this image.\n\nIt is currently defined as the Main View for ${usageCount} component(s).\nPlease reassign or delete these components first.`);
		return;
	}

	// Note: confirmAction uses z-index 1100, so it appears over settings
	if(await confirmAction("Delete current image?", "Delete Image")) {
		await db.deleteImage(currentImgId);

		// Remove from UI arrays
		bomImages = bomImages.filter(i => i.id !== currentImgId);

		// Close the settings modal if open
		history.back();

		currentImgId = null;
		await loadProjectData();
		resetStickyEditor();
	}
}

function clearMap() { document.getElementById('map-content').innerHTML = `<div id="map-placeholder" class="empty-state" style="color:white; padding-top:20vh;"><h3>No Image</h3></div>`; }

async function updateOverlapCache() {
	if (!currentImgId) { currentOverlaps = []; return; }

	const connections = await getConnectedImages(currentImgId);

	currentOverlaps = connections.map(conn => {
		// Use the clean helper method within ImageGraph
		const invMat = ImageGraph.invertH(conn.matrix);

		return {
			fromImageId: conn.sourceId,
			toImageId: currentImgId,
			homography: invMat,
			inverseHomography: conn.matrix,
			isValid: !!invMat
		};
	}).filter(o => o.isValid);
}

function renderPins() {
	document.querySelectorAll('.map-pin').forEach(p => p.remove());
	if (!currentImgId) return;

	bomData.forEach(c => {
		let x = null, y = null;
		let isInferred = false;

		// A: Defined on this image (Blue)
		if (c.imgId === currentImgId && c.x !== undefined) {
			x = c.x; y = c.y;
		}
		// B: Inferred from stitching (Green)
		else if (c.imgId && c.imgId !== currentImgId && c.x !== undefined) {
			const ov = currentOverlaps.find(o => o.fromImageId === c.imgId || o.toImageId === c.imgId);
			if (ov) {
				const isForward = (ov.fromImageId === c.imgId);
				const H = isForward ? ov.homography : ov.inverseHomography;
				const proj = cvManager.projectPoint(c.x, c.y, H);
				if (proj && proj.x > 0 && proj.y > 0) {
					 x = proj.x; y = proj.y; isInferred = true;
				}
			}
		}

		if (x !== null && y !== null) {
			const pin = document.createElement('div');
			pin.className = 'map-pin';
			pin.style.left = x + 'px';
			pin.style.top = y + 'px';

			const color = isInferred ? '#16a34a' : 'var(--primary)';
			const zIndex = isInferred ? 40 : 50;

			// Both Green and Blue pins now open the Editor
			const clickAction = `editCompFromMap('${c.id}', event)`;

			pin.innerHTML = `<div class="pin-marker" style="background:${color}; z-index:${zIndex};" onclick="${clickAction}; event.stopPropagation();"><span>${c.label}</span></div>`;
			document.getElementById('map-content').appendChild(pin);
		}
	});
}
function updateTransform() { document.getElementById('map-content').style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`; }
const viewport = document.getElementById('map-viewport');
viewport.addEventListener('wheel', e => {
	e.preventDefault();
	const rect = viewport.getBoundingClientRect();
	const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
	const ix = (mx - mapState.x) / mapState.scale; const iy = (my - mapState.y) / mapState.scale;
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	const newScale = Math.max(0.1, Math.min(10, mapState.scale + delta));
	mapState.x = mx - (ix * newScale); mapState.y = my - (iy * newScale); mapState.scale = newScale;
	updateTransform();
});
/* --- POINTER EVENTS (Mobile + Desktop) --- */

let evCache = [];
let prevDiff = -1;

function pointerDownHandler(e) {
	if(e.target.closest('.pin-marker')) return;

	evCache.push(e);

	// 1. Single Pointer (Mouse or One Finger) -> Start Drag
	if (evCache.length === 1) {
		mapState.isDragging = true;
		mapState.startX = e.clientX - mapState.x;
		mapState.startY = e.clientY - mapState.y;
		mapState.rawStartX = e.clientX;
		mapState.rawStartY = e.clientY;

		// Listen globally while dragging (Fixes "fast drag" issue on Desktop)
		window.addEventListener('pointermove', pointerMoveHandler);
		window.addEventListener('pointerup', pointerUpHandler);
	}

	// 2. Two Pointers (Pinch) -> Switch to Zoom
	else if (evCache.length === 2) {
		mapState.isDragging = false; // Disable pan during pinch
		const dx = evCache[0].clientX - evCache[1].clientX;
		const dy = evCache[0].clientY - evCache[1].clientY;
		prevDiff = Math.hypot(dx, dy);
	}
}

function pointerMoveHandler(e) {
	// Update event in cache (for Pinch calc)
	const index = evCache.findIndex(cached => cached.pointerId === e.pointerId);
	if(index > -1) evCache[index] = e;

	// A. PINCH ZOOM (Mobile)
	if (evCache.length === 2) {
		const dx = evCache[0].clientX - evCache[1].clientX;
		const dy = evCache[0].clientY - evCache[1].clientY;
		const curDiff = Math.hypot(dx, dy);

		if (prevDiff > 0) {
			const diff = curDiff - prevDiff;
			const newScale = Math.max(0.1, Math.min(10, mapState.scale + (diff * 0.01)));

			// Zoom towards center
			const rect = viewport.getBoundingClientRect();
			const cx = rect.width / 2;
			const cy = rect.height / 2;
			const ratio = newScale / mapState.scale;

			mapState.x = cx - (cx - mapState.x) * ratio;
			mapState.y = cy - (cy - mapState.y) * ratio;
			mapState.scale = newScale;

			updateTransform();
		}
		prevDiff = curDiff;
		return;
	}

	// B. PANNING (Desktop + Mobile)
	if(!mapState.isDragging) return;

	// e.preventDefault() helps stop scrolling on mobile,
	// but we check pointerType to avoid selecting text issues on desktop
	if(e.pointerType === 'touch') e.preventDefault();

	mapState.x = e.clientX - mapState.startX;
	mapState.y = e.clientY - mapState.startY;
	updateTransform();
}

function pointerUpHandler(e) {
	const index = evCache.findIndex(cached => cached.pointerId === e.pointerId);
	if(index > -1) evCache.splice(index, 1);

	if (evCache.length < 2) prevDiff = -1;

	if (evCache.length === 0) {
		mapState.isDragging = false;
		// Clean up global listeners
		window.removeEventListener('pointermove', pointerMoveHandler);
		window.removeEventListener('pointerup', pointerUpHandler);
	}
}

// Only 'pointerdown' needs to be on the viewport
viewport.addEventListener('pointerdown', pointerDownHandler);

// Click Logic (Distinguishes Drag vs Click)
viewport.addEventListener('click', e => {
	const dist = Math.hypot(e.clientX - mapState.rawStartX, e.clientY - mapState.rawStartY);
	if(dist > 10) return; // Ignore if dragged

	if(mapState.isDragging || !currentImgId || e.target.closest('.pin-marker')) return;

	const r = document.getElementById('map-content').getBoundingClientRect();
	const x = (e.clientX - r.left) / mapState.scale;
	const y = (e.clientY - r.top) / mapState.scale;

	switchView('list');

	// 1. Deselect any active row in the table (Visual cleanup)
	document.querySelectorAll('tbody tr').forEach(row => row.classList.remove('editing'));

	// 2. Create a temporary "New Component" object
	const tempComp = {
		label: '',
		value: '',
		desc: '',
		imgId: currentImgId,
		x: Math.round(x),
		y: Math.round(y)
	};

	// 3. Use the standard function to setup UI (Inputs + Spyglass + THUMBNAILS)
	fillFormFromData(tempComp);

	// 4. Focus for immediate typing
	document.getElementById('inp-label').focus();
	returnToMap = true;
});
async function editCompFromMap(id, e) {
	e.stopPropagation();
	const comp = bomData.find(c => c.id === id);
	if(!comp) return;
	fillFormFromData(comp);
	returnToMap = true;
	switchView('list');

	// [NEW] Synchronize List Selection
	setTimeout(() => {
		const row = document.querySelector(`#bom-body tr[data-id="${id}"]`);
		if(row) {
			// Clear existing
			document.querySelectorAll('tbody tr').forEach(x => x.classList.remove('editing'));
			// Highlight new
			row.classList.add('editing');
			// Scroll into view
			row.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}, 50); // Small delay to ensure view transition allows scrolling
}
async function fillFormFromData(c) {
	// Reset state: Default view is always Main
	isMainViewActive = true;

	// 1. Fill Text Fields
	document.getElementById('inp-id').value = c.id || '';
	document.getElementById('inp-label').value = c.label;
	document.getElementById('inp-value').value = c.value;
	document.getElementById('inp-desc').value = c.desc;
	document.getElementById('inp-x').value = (c.x !== undefined) ? c.x : '';
	document.getElementById('inp-y').value = (c.y !== undefined) ? c.y : '';
	document.getElementById('inp-img-id').value = c.imgId || '';

	checkToolHint(c.label);

	// 2. Clear previous thumbnails
	const thumbBox = document.getElementById('inline-thumbs');
	if(thumbBox) thumbBox.innerHTML = '';

	// --- HELPER: Set Spyglass Target ---
	const setMainView = (imgRecOrSource, x, y) => {
		if(!spyglass) return;
		if(imgRecOrSource instanceof HTMLElement || imgRecOrSource instanceof ImageBitmap) {
			spyglass.setTarget(imgRecOrSource, x, y, false);
			return;
		}
		if(imgRecOrSource && imgRecOrSource.blob) {
			createImageBitmap(imgRecOrSource.blob).then(bmp => {
				spyglass.setTarget(bmp, x, y, true);
			});
		}
	};

	// --- HELPER: Create Thumbnail ---
	const createThumb = (imgRec, tx, ty, isMain) => {
		const thumb = document.createElement('div');
		thumb.style.cssText = "width:60px; height:60px; border:1px solid #cbd5e1; flex-shrink:0; cursor:pointer; position:relative; background:#eee; display:flex; align-items:center; justify-content:center;";
		if(isMain) thumb.style.borderColor = "#2563eb";

		// Loader placeholder
		thumb.innerHTML = '<span style="font-size:10px; color:#999;">...</span>';
		thumbBox.appendChild(thumb);

		(async () => {
			try {
				const bmp = await createImageBitmap(imgRec.blob);

				// 1. Clear loader (and anything else)
				thumb.innerHTML = '';

				// 2. Add Canvas
				const cvs = document.createElement('canvas');
				cvs.width = 60; cvs.height = 60;
				const ctx = cvs.getContext('2d');
				ctx.drawImage(bmp, tx-50, ty-50, 100, 100, 0, 0, 60, 60);
				thumb.appendChild(cvs);
				thumb.title = isMain ? "Main View" : `View on ${imgRec.name}`;

				bmp.close();

				// 3. Add Locate Button 🎯 (Now safe from being cleared)
				const locBtn = document.createElement('button');
				locBtn.className = 'thumb-locate-btn';
				locBtn.innerHTML = '🎯';
				locBtn.title = "Locate on Map";
				locBtn.onclick = (e) => { e.stopPropagation(); locateComponent(imgRec.id, tx, ty); };
				thumb.appendChild(locBtn);

				// 4. Add Promote Button ★
				if (!isMain) {
					const btn = document.createElement('button');
					btn.className = 'thumb-promote-btn';
					btn.innerHTML = '★';
					btn.title = "Set as Main View";
					btn.onclick = async (e) => {
						e.stopPropagation();

						// Capture form state
						c.id = document.getElementById('inp-id').value;
						c.label = document.getElementById('inp-label').value;
						c.value = document.getElementById('inp-value').value;
						c.desc = document.getElementById('inp-desc').value;

						// Update component location
						c.imgId = imgRec.id; c.x = tx; c.y = ty;

						// Update DB if exists
						if(c.id) { await db.addComponent(c); await loadProjectData(); }

						// Refresh UI
						fillFormFromData(c);
					};
					thumb.appendChild(btn);
				}

				// Thumb Click Action
				thumb.onclick = () => {
					Array.from(thumbBox.children).forEach(t => t.style.borderColor = '#cbd5e1');
					thumb.style.borderColor = "#2563eb";
					isMainViewActive = isMain;
					setMainView(imgRec, tx, ty);
				};

			} catch(e) {
				console.error("Thumb error", e);
				thumb.innerHTML = '<span style="color:red">x</span>';
			}
		})();
	};

	// 3. Calculate Views
	const viewsToRender = [];
	let mainImgRec = null;
	if((c.x !== undefined) && (c.y !== undefined) && c.imgId) {
		mainImgRec = bomImages.find(i => i.id === c.imgId);
		if(mainImgRec) {
			viewsToRender.push({ rec: mainImgRec, x: c.x, y: c.y, isMain: true });

			// Initial Load: Check if Map is already showing this
			const mapImg = document.getElementById('map-content') ? document.getElementById('map-content').querySelector('.pcb-image') : null;
			if(mapImg && mapImg.dataset.id === c.imgId && mapImg.complete && mapImg.naturalWidth > 0 && spyglass) {
				spyglass.setTarget(mapImg, c.x, c.y, false);
			} else {
				setMainView(mainImgRec, c.x, c.y);
			}
		} else if (spyglass) { spyglass.clear(); }
	}

	if (cvManager && db && c.imgId) {
		const paths = await ImageGraph.solvePaths(c.imgId, cvManager, db);

		for (const pData of paths) {
			const H_new = pData.H;
			const pt = cvManager.projectPoint(c.x, c.y, H_new);

			if (pt && pt.x > 0 && pt.y > 0) {
				const targetRec = bomImages.find(i => i.id === pData.id);
				if (targetRec) {
					// Check bounds if bitmap is available, or trust projectPoint roughly
					// Usually we need the bitmap dimensions to be 100% sure,
					// but rendering it via createThumb handles out-of-bounds gracefully (crops/blank)
					viewsToRender.push({ rec: targetRec, x: pt.x, y: pt.y, isMain: false });
				}
			}
		}
	}

	// 4. Render All
	viewsToRender.forEach(v => createThumb(v.rec, v.x, v.y, v.isMain));
}
function copyPartToForm(idx) { const c = bomData[idx]; document.getElementById('inp-value').value = c.value; document.getElementById('inp-desc').value = c.desc; }

// --- CONNECTIONS UI ---
//	Delete connection function
async function deleteConnection(targetId) {
	if(!currentImgId || !targetId) return;

	const targetImg = bomImages.find(i => i.id === targetId);
	const name = targetImg ? targetImg.name : "this image";

	if(await confirmAction(`Remove stitching connection with ${name}?`, "Remove Stitch")) {
		await db.deleteOverlapsForPair(currentImgId, targetId);
		await renderConnectionsList();
		await updateOverlapCache();
		renderPins();
	}
}

// Note: Ensure this function is called by openConnectionsModal() in your existing code
async function renderConnectionsList() {
	if(!currentImgId) return;
	const curImg = bomImages.find(i => i.id === currentImgId);
	if(!curImg) return;

	const title = document.getElementById('conn-src-name');
	if(title) title.innerText = curImg.name;

	const list = document.getElementById('conn-list');
	if(!list) return;

	list.innerHTML = '<div style="text-align:center;color:#888">Loading...</div>';

	const overlaps = await db.getOverlapsForImage(currentImgId);
	const others = bomImages.filter(i => i.id !== currentImgId);

	list.innerHTML = '';
	if(others.length === 0) {
		list.innerHTML = '<div style="padding:1rem; text-align:center; background:#eee; border-radius:4px;">No other images to stitch with.</div>';
		return;
	}

	others.forEach(img => {
		const ov = overlaps.find(o => o.fromImageId === img.id || o.toImageId === img.id);
		const row = document.createElement('div');
		row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:0.5rem; border:1px solid #e2e8f0; border-radius:0.3rem; background:white;";
		let statusBadge = `<span style="font-size:0.75rem; background:#f1f5f9; color:#94a3b8; padding:2px 6px; border-radius:4px;">Not Connected</span>`;
		let actions = `<button class="secondary sm-btn" onclick="launchStitch('${img.id}')">Edit Stitch</button>`;

		if(ov) {
			if(ov.isManual) statusBadge = `<span style="font-size:0.75rem; background:#dcfce7; color:#166534; padding:2px 6px; border-radius:4px;">Manual (${ov.matchCount} pts)</span>`;
			else statusBadge = `<span style="font-size:0.75rem; background:#e0f2fe; color:#0369a1; padding:2px 6px; border-radius:4px;">Auto-CV</span>`;

			// Show Delete + Edit buttons
			actions = `<div style="display:flex; gap:5px;">
				<button class="danger sm-btn" style="padding:0 8px;" onclick="deleteConnection('${img.id}')" title="Remove Connection">🗑️</button>
				<button class="secondary sm-btn" onclick="launchStitch('${img.id}')">Edit Stitch</button>
			</div>`;
		}

		row.innerHTML = `<div><div style="font-weight:600; font-size:0.9rem;">${img.name}</div>${statusBadge}</div>${actions}`;
		list.appendChild(row);
	});
}

// Uses the helper above
async function openConnectionsModal() {
	if(!currentImgId) return alert("Select an image first.");
	document.getElementById('connections-modal').style.display = 'flex';
	await renderConnectionsList();
}

function launchStitch(targetId) {
	document.getElementById('connections-modal').style.display = 'none';
	if(stitchEditor) stitchEditor.open(currentImgId, targetId);
	else alert("Editor not initialized.");
}

async function runAutoCVBatch() {
	if(!cvManager || !cvManager.ready) { cvManager.init(); return alert("CV initializing... wait."); }
	if(!await confirmAction("Run Auto-CV on all unmatched images?", "Run Auto-CV")) return;

	// Capture ID locally to prevent errors if user switches image during processing
	const sourceId = currentImgId;
	if(!sourceId) return;

	document.getElementById('conn-list').innerHTML = '<div style="text-align:center; padding:2rem;">Processing...</div>';

	// Only filter out self; bomImages is already scoped to project
	const others = bomImages.filter(i => i.id !== sourceId);
	const sourceBlob = bomImages.find(i => i.id === sourceId).blob;

	for(const other of others) {
		const existing = await db.getOverlapsForPair(sourceId, other.id);
		if(existing && existing.isManual) continue;

		const blob1 = sourceBlob;
		const blob2 = other.blob;

		const f1 = await cvManager.feats(blob1);
		const f2 = await cvManager.feats(blob2);

		if(f1 && f2) {
			const res = cvManager.findH(f1, f2);
			if(res) {
				await db.deleteOverlapsForPair(sourceId, other.id);
				await db.addOverlap({
					id: uuid(),
					fromImageId: sourceId,
					toImageId: other.id,
					homography: res.hData,
					inverseHomography: res.invHData,
					matchCount: res.matches,
					isManual: false
				});
			}
		}
		if(f1) { f1.kp.delete(); f1.des.delete(); }
		if(f2) { f2.kp.delete(); f2.des.delete(); }
	}
	await renderConnectionsList();
	updateOverlapCache().then(renderPins);
}

// UI Helper: Shows a global blocking overlay with a message
function showBusy(msg) {
	let el = document.getElementById('busy-indicator');
	if(!el) {
		el = document.createElement('div');
		el.id = 'busy-indicator';
		el.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.8); color:white; padding:20px; border-radius:8px; z-index:9999; font-weight:bold; display:flex; align-items:center; gap:10px; box-shadow: 0 4px 15px rgba(0,0,0,0.3);";
		document.body.appendChild(el);
	}
	el.innerHTML = `<span style="animation:spin 1s linear infinite; display:inline-block">⏳</span> ${msg}`;
	el.style.display = 'flex';
}

function hideBusy() {
	const el = document.getElementById('busy-indicator');
	if(el) el.style.display = 'none';
}

// Logic: Auto-stitch specific image against all others on the board
async function autoStitchNewImage(newId) {
	if(!cvManager) cvManager = new CVManager();
	if(!cvManager.ready) {
		showBusy("Initializing Computer Vision...");
		await cvManager.init();
	}

	// Find the newly added image object
	const newImg = bomImages.find(i => i.id === newId);
	if(!newImg) return;

	// Filter existing images (exclude the new one)
	const others = bomImages.filter(i => i.id !== newId);
	if(others.length === 0) return;

	try {
		showBusy("Extracting features from new image...");

		// 1. Compute features for the NEW image ONCE
		const fNew = await cvManager.feats(newImg.blob);
		if(!fNew) { hideBusy(); return; }

		let matchesFound = 0;

		// 2. Compare against all others
		for(let i=0; i<others.length; i++) {
			const other = others[i];
			showBusy(`Stitching vs ${other.name}... (${i+1}/${others.length})`);

			// Tiny pause to let UI render the text update
			await new Promise(r => setTimeout(r, 10));

			const fOther = await cvManager.feats(other.blob);
			if(fOther) {
				const res = cvManager.findH(fNew, fOther);
				if(res) {
					await db.addOverlap({
						id: uuid(),
						fromImageId: newId,
						toImageId: other.id,
						homography: res.hData,
						inverseHomography: res.invHData,
						matchCount: res.matches,
						isManual: false
					});
					matchesFound++;
				}
				// Free memory for the 'other' image immediately
				if(fOther.kp) fOther.kp.delete();
				if(fOther.des) fOther.des.delete();
			}
		}

		// Free memory for the 'new' image
		if(fNew.kp) fNew.kp.delete();
		if(fNew.des) fNew.des.delete();

	} catch(e) {
		console.error("Auto-stitch failed", e);
	} finally {
		hideBusy();
		// Refresh overlaps if we successfully matched anything
		if(await db.getOverlapsForImage(newId).length > 0) {
			await updateOverlapCache();
			renderPins();
		}
	}
}

const ImageGraph = {
	// Helper: Invert 3x3 Matrix
	invertH(m) {
		if (!m || m.length !== 9) return null;
		const det = m[0] * (m[4] * m[8] - m[7] * m[5]) -
					m[1] * (m[3] * m[8] - m[5] * m[6]) +
					m[2] * (m[3] * m[7] - m[4] * m[6]);
		if (Math.abs(det) < 1e-10) return null;
		const invDet = 1 / det;
		return [
			(m[4] * m[8] - m[5] * m[7]) * invDet,
			(m[2] * m[7] - m[1] * m[8]) * invDet,
			(m[1] * m[5] - m[2] * m[4]) * invDet,
			(m[5] * m[6] - m[3] * m[8]) * invDet,
			(m[0] * m[8] - m[2] * m[6]) * invDet,
			(m[2] * m[3] - m[0] * m[5]) * invDet,
			(m[3] * m[7] - m[4] * m[6]) * invDet,
			(m[1] * m[6] - m[0] * m[7]) * invDet,
			(m[0] * m[4] - m[1] * m[3]) * invDet
		];
	},

	// Returns array of { id, H, totalCost } for all reachable nodes
	async solvePaths(startImgId, cvMgr, db) {
		const allOverlaps = await db._tx('overlappedImages', 'readonly', s => s.getAll());

		// 1. Build Adjacency List
		const graph = {};
		allOverlaps.forEach(ov => {
			if(!graph[ov.fromImageId]) graph[ov.fromImageId] = [];
			// Forward: Source -> Target (Homography)
			graph[ov.fromImageId].push({ id: ov.toImageId, H: ov.homography, cost: ov.isManual ? 1 : 1000 });

			if(!graph[ov.toImageId]) graph[ov.toImageId] = [];
			// Backward: Target -> Source (Inverse)
			graph[ov.toImageId].push({ id: ov.fromImageId, H: ov.inverseHomography, cost: ov.isManual ? 1 : 1000 });
		});

		// 2. Dijkstra Search
		const results = [];
		const queue = [{ id: startImgId, H: [1,0,0, 0,1,0, 0,0,1], totalCost: 0 }];
		const visited = new Set();

		while(queue.length > 0) {
			queue.sort((a, b) => a.totalCost - b.totalCost);
			const curr = queue.shift();

			if(visited.has(curr.id)) continue;
			visited.add(curr.id);

			// Add to results (excluding start node)
			if (curr.id !== startImgId) {
				results.push({ id: curr.id, H: curr.H, totalCost: curr.totalCost });
			}

			if(graph[curr.id]) {
				for(const edge of graph[curr.id]) {
					if(!visited.has(edge.id)) {
						const H_next = cvMgr.multiplyH(edge.H, curr.H);
						queue.push({
							id: edge.id,
							H: H_next,
							totalCost: curr.totalCost + edge.cost
						});
					}
				}
			}
		}
		return results;
	}
};

/* --- NAVIGATION & HISTORY MANAGER --- */
const NavManager = {
	init() {
		window.addEventListener('popstate', (e) => this.handlePopState(e));

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				if (history.state && history.state.context) {
					history.back();
				} else {
					this.handleEscDirectly();
				}
			}
		});

		window.addEventListener('message', (e) => {
			if (e.data.type === 'ESC_PRESSED') {
				const visible = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display === 'flex');
				if(visible) history.back();
			}
		});

		document.querySelectorAll('.close-btn').forEach(btn => {
			btn.onclick = (e) => {
				e.preventDefault(); e.stopPropagation();
				history.back();
			};
		});

		const mm = document.getElementById('mobile-menu-modal');
		if(mm) {
			mm.onclick = (e) => { if(e.target === mm) history.back(); };
		}

		this.applyPatches();
	},

	pushState(context, data = {}) {
		// Prevent duplicate pushes of the same context
		if (history.state && history.state.context === context) return;
		history.pushState({ context, ...data }, "", "");
	},

	handlePopState(e) {
		const state = e.state || {};
		const ctx = state.context;

		// 1. Close Modals
		document.querySelectorAll('.modal-overlay').forEach(el => el.style.display = 'none');
		if(typeof ImageImporter !== 'undefined') ImageImporter.close(true);
		if(typeof iframe !== 'undefined') { iframe.style.display = 'none'; iframe.src = 'about:blank'; }

		// 2. Restore View
		if (ctx === 'map') {
			switchView('map', true); // Pass true to skip pushState
		} else if (ctx === 'nets') {
			switchView('nets', true);
		} else if (ctx === 'inspect') {
			switchView('inspect', true);
		} else {
			// Default to List
			switchView('list', true);

			// Restore Tool if needed
			if (ctx === 'tool') this.restoreTool();

			// Restore Modals
			if (ctx && ctx.endsWith('-modal')) {
				const el = document.getElementById(ctx);
				if(el) el.style.display = 'flex';
			}
		}
	},

	handleEscDirectly() {
		const visibleModal = Array.from(document.querySelectorAll('.modal-overlay')).reverse().find(m => m.style.display === 'flex');
		if (visibleModal) {
			visibleModal.style.display = 'none';
		} else {
			// If on any tab other than list, go back to list
			const activeView = document.querySelector('.view-section.active');
			if (activeView && activeView.id !== 'view-list') {
				switchView('list');
			}
		}
	},

	restoreTool() {
		if (iframe && iframe.src) modal.style.display = 'flex';
	},

	applyPatches() {
		const originalSwitchView = switchView;
		// Wrap switchView to handle history pushing automatically
		switchView = function(v, fromHistory = false) {
			originalSwitchView(v);
			if (!fromHistory) {
				NavManager.pushState(v);
			}
		};

		const originalOpenToolD = openToolD;
		openToolD = async function(idx, url, tit) {
			await originalOpenToolD(idx, url, tit);
			NavManager.pushState('tool');
		};

		const originalCloseTool = closeTool;
		closeTool = function() {
			if(history.state && history.state.context === 'tool') history.back();
			else originalCloseTool();
		};

		const wrapModalOpener = (fnName, modalId) => {
			if (typeof window[fnName] === 'function') {
				const original = window[fnName];
				window[fnName] = function(...args) {
					original.apply(this, args);
					NavManager.pushState(modalId);
				};
			}
		};

		wrapModalOpener('openBoardSettings', 'board-settings-modal');
		wrapModalOpener('openDeviceSettings', 'device-settings-modal');
		wrapModalOpener('openConnectionsModal', 'connections-modal');
		wrapModalOpener('openImageSettings', 'image-settings-modal');
		wrapModalOpener('openMobileMenu', 'mobile-menu-modal');

		if(typeof stitchEditor !== 'undefined' && stitchEditor) {
			const origStitchOpen = stitchEditor.open.bind(stitchEditor);
			stitchEditor.open = async function(src, dst) {
				await origStitchOpen(src, dst);
				NavManager.pushState('stitch-modal');
			};
		}

		if(typeof ImageImporter !== 'undefined') {
			const origImgOpen = ImageImporter.openModal.bind(ImageImporter);
			ImageImporter.openModal = function(mode) {
				origImgOpen(mode);
				if(!history.state || history.state.context !== 'import-modal') {
					 NavManager.pushState('import-modal');
				}
			};
			ImageImporter.close = function(silent = false) {
				this.modal.style.display = 'none';
				this.stopStream();
				this.sourceImage = null;
				this.cropRect = null;
				if(!silent && history.state && history.state.context === 'import-modal') {
					history.back();
				}
			};
		}
	}
};

/**
 * Generic Input Dialog Helper
 * @param {string} title - Modal Title
 * @param {string} label - Input Field Label
 * @param {string} val - Default Value
 * @param {object} opts - { extraBtn: {label, value, class} }
 * @returns Promise<string|null> - Returns input value, extraBtn value, or null (cancel)
 */
function requestInput(title, label, val, opts = {}) {
	return new Promise((resolve) => {
		const modal = document.getElementById('generic-input-modal');
		const inp = document.getElementById('gim-input');
		const extraBtn = document.getElementById('gim-extra-btn');
		const modalContext = 'generic-input-modal';

		document.getElementById('gim-title').innerText = title;
		document.getElementById('gim-label').innerText = label;
		inp.value = val || '';

		let resultToResolve = null;

		// 1. Cleanup & Resolve
		const close = () => {
			window.removeEventListener('popstate', onPopState);
			modal.style.display = 'none';
			resolve(resultToResolve);
		};

		// 2. Handle History Changes (Back Button)
		const onPopState = (e) => {
			// If we are here, history has ALREADY popped.
			// Just close the UI.
			close();
		};

		// 3. Handle UI Actions (OK / Cancel)
		const commit = (v) => {
			resultToResolve = v;

			// SAFETY CHECK: Only go back if we are still in the modal state.
			// This prevents "Double Back" if the user mashed buttons or browser lagged.
			if (history.state && history.state.context === modalContext) {
				history.back(); // This will trigger onPopState -> close()
			} else {
				// We are already out of state (shouldn't happen, but safe fallback)
				close();
			}
		};

		// 4. Setup DOM
		const newOk = document.getElementById('gim-ok-btn').cloneNode(true);
		const newCancel = document.getElementById('gim-cancel-btn').cloneNode(true);
		const newExtra = extraBtn.cloneNode(true);

		document.getElementById('gim-ok-btn').replaceWith(newOk);
		document.getElementById('gim-cancel-btn').replaceWith(newCancel);
		extraBtn.replaceWith(newExtra);

		// StopPropagation prevents clicks from bubbling to Inspector canvas (Ghost clicks)
		newOk.onclick = (e) => { e.stopPropagation(); commit(inp.value.trim()); };
		newCancel.onclick = (e) => { e.stopPropagation(); commit(null); };

		if(opts.extraBtn) {
			newExtra.style.display = 'block';
			newExtra.innerText = opts.extraBtn.label;
			newExtra.className = opts.extraBtn.class || 'danger';
			newExtra.onclick = (e) => { e.stopPropagation(); commit(opts.extraBtn.value); };
		} else {
			newExtra.style.display = 'none';
		}

		modal.querySelector('.close-btn').onclick = (e) => { e.stopPropagation(); commit(null); };

		inp.onkeydown = (e) => {
			if(e.key === 'Enter') {
				e.preventDefault();
				newOk.click();
			}
			// Let NavManager handle Escape -> history.back()
		};

		// 5. Open & Push State
		// Use direct history.pushState to ensure it happens immediately and locally
		// (Bypassing any potential NavManager checks/delays)
		if (!history.state || history.state.context !== modalContext) {
			history.pushState({ context: modalContext }, "", "");
		}

		window.addEventListener('popstate', onPopState);
		modal.style.display = 'flex';
		inp.focus();
		inp.select();
	});
}

/* --- URL IMPORT LOGIC --- */

async function importDeviceFromURL() {
	// Use existing generic input modal
	const url = await requestInput("Import Device", "ZIP URL", "https://");
	if (url) {
		await processUrlImport(url.trim());
	}
}

async function processUrlImport(url) {
	if (!url) return;

	showBusy("Downloading Device...");

	try {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
		}

		const blob = await response.blob();

		// 1. Determine Filename
		// Clean query params (e.g. ?token=...) to check extension
		const cleanUrl = url.split('?')[0].split('#')[0];
		let filename = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);

		// 2. Fallback if filename is empty or doesn't look like a zip
		// (importFile logic relies on .zip extension to detect mode)
		if (!filename || !filename.toLowerCase().endsWith('.zip')) {
			filename = "downloaded_device.zip";
		}

		// 3. Create Virtual File
		// Note: 'new File' is supported in all modern browsers (Safari 10+, Chrome, FF)
		const file = new File([blob], filename, { type: blob.type || 'application/zip' });

		hideBusy();

		// 4. Handover to existing Import logic
		await importFile(file);

	} catch (e) {
		hideBusy();
		console.error("URL Import Error:", e);

		// User-friendly error regarding CORS
		let msg = `Import Failed.\n\nError: ${e.message}`;
		if (e.name === 'TypeError' && e.message === 'Failed to fetch') {
			msg += `\n\nPossible Cause: CORS Restriction.\nThe server hosting this ZIP must send the header:\n"Access-Control-Allow-Origin: *"`;
		}
		alert(msg);
	}
}

// Start
window.onload = init;

window.exportKiCad = () => {
	if (window.netManager) window.netManager.exportKiCad();
};

window.startNewNet = () => {
	if (window.inspector) window.inspector.startNewNet();
};
