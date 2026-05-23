/* db-core.js - Shared database initialization and schema definitions */

// Global UUID generator shared across all components
window.uuid = function() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
};

window.PcbDbCore = {
	DB_NAME: 'PcbReTrace',
	DB_VER: 3,

	setupDatabase: function(d, tx) {
		if (d.objectStoreNames.contains('projects')) d.deleteObjectStore('projects');
		if (!d.objectStoreNames.contains('devices')) d.createObjectStore('devices', {keyPath: 'id'});
		if (!d.objectStoreNames.contains('boards')) {
			const bs = d.createObjectStore('boards', {keyPath: 'id'});
			bs.createIndex('deviceId', 'deviceId', {unique: false});
		}
		if (!d.objectStoreNames.contains('components')) {
			const cs = d.createObjectStore('components', {keyPath: 'id'});
			cs.createIndex('boardId', 'boardId', {unique: false});
		}
		if (!d.objectStoreNames.contains('images')) {
			const is = d.createObjectStore('images', {keyPath: 'id'});
			is.createIndex('boardId', 'boardId', {unique: false});
		}
		if (!d.objectStoreNames.contains('overlappedImages')) {
			const os = d.createObjectStore('overlappedImages', {keyPath: 'id'});
			os.createIndex('fromImageId', 'fromImageId');
		}
		if (!d.objectStoreNames.contains('nets')) {
			d.createObjectStore('nets', {keyPath: 'id'});
		}

		const netsStore = tx.objectStore('nets');
		if (!netsStore.indexNames.contains('projectId')) {
			netsStore.createIndex('projectId', 'projectId', {unique: false});
		}

		if (!d.objectStoreNames.contains('pinDirections')) {
			d.createObjectStore('pinDirections', {keyPath: 'id'});
		}
		if (!d.objectStoreNames.contains('symbolTypes')) {
			const st = d.createObjectStore('symbolTypes', {keyPath: 'id'});
			st.createIndex('parentId', 'parentId', {unique: false});
		}
		if (!d.objectStoreNames.contains('kicadSymbols')) {
			const ks = d.createObjectStore('kicadSymbols', {keyPath: 'id'});
			ks.createIndex('library', 'library', {unique: false});
			ks.createIndex('pinCount', 'pinCount', {unique: false});
		} else {
			const ks = tx.objectStore('kicadSymbols');
			if (!ks.indexNames.contains('pinCount')) {
				ks.createIndex('pinCount', 'pinCount', {unique: false});
			}
		}
		if (!d.objectStoreNames.contains('componentTypes')) {
			const ct = d.createObjectStore('componentTypes', {keyPath: 'id'});
			ct.createIndex('symbolTypeId', 'symbolTypeId', {unique: false});
		}
		if (!d.objectStoreNames.contains('componentTypeKicadSymbols')) {
			const ck = d.createObjectStore('componentTypeKicadSymbols', {keyPath: 'id'});
			ck.createIndex('componentTypeId', 'componentTypeId', {unique: false});
			ck.createIndex('kicadSymbolId', 'kicadSymbolId', {unique: false});
		}
		if (!d.objectStoreNames.contains('componentTypePins')) {
			const cp = d.createObjectStore('componentTypePins', {keyPath: 'id'});
			cp.createIndex('componentTypeId', 'componentTypeId', {unique: false});
		}
		if (!d.objectStoreNames.contains('schemas')) {
			const ss = d.createObjectStore('schemas', {keyPath: 'id'});
			ss.createIndex('deviceId', 'deviceId', {unique: false});
			ss.createIndex('boardId', 'boardId', {unique: false});
		}
		if (!d.objectStoreNames.contains('schemaComponents')) {
			const sc = d.createObjectStore('schemaComponents', {keyPath: 'id'});
			sc.createIndex('schemaId', 'schemaId', {unique: false});
			sc.createIndex('componentId', 'componentId', {unique: false});
		}
	}
};
