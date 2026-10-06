// IndexedDB layer (plan.md section 2) with an in-memory fallback used when
// IndexedDB is unavailable or a write fails. The store's public API is the
// same shape either way, so callers never branch on which mode is active -
// they just check the boolean each put() resolves to, to drive the
// "Saved" indicator / red banner.

(function (root) {
  'use strict';

  const DB_NAME = 'pickleball-tracker';
  const DB_VERSION = 1;

  function defaultCategory(id, name, court) {
    return { id, name, court, status: 'registration', teams: [], results: {}, updatedAt: Date.now() };
  }

  function defaultMeta() {
    return { title: 'Pickleball Tournament', lastBackupAt: null, resultsSinceBackup: 0 };
  }

  function openIndexedDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in root) || !root.indexedDB) { reject(new Error('IndexedDB not available')); return; }
      let req;
      try {
        req = root.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) { reject(err); return; }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
  }

  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, store, value, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function createStore() {
    let db = null;
    let mode = 'indexeddb';
    const memory = { categories: {}, meta: null };

    async function degradeToMemory() {
      if (mode === 'memory') return;
      try {
        memory.categories.A = await idbGet(db, 'categories', 'A');
        memory.categories.B = await idbGet(db, 'categories', 'B');
        memory.meta = await idbGet(db, 'meta', 'event');
      } catch (err) { /* best effort copy; proceed with whatever we have */ }
      mode = 'memory';
      db = null;
    }

    async function init() {
      try {
        db = await openIndexedDB();
        mode = 'indexeddb';
      } catch (err) {
        mode = 'memory';
        db = null;
      }
      let a = await getCategory('A');
      if (!a) { a = defaultCategory('A', 'Category A', 'Court 1'); await putCategory(a); }
      let b = await getCategory('B');
      if (!b) { b = defaultCategory('B', 'Category B', 'Court 2'); await putCategory(b); }
      let meta = await getMeta();
      if (!meta) { meta = defaultMeta(); await putMeta(meta); }
      return mode;
    }

    async function getCategory(id) {
      if (mode === 'memory') return memory.categories[id] || null;
      try { return await idbGet(db, 'categories', id); }
      catch (err) { await degradeToMemory(); return memory.categories[id] || null; }
    }

    async function putCategory(record) {
      record.updatedAt = Date.now();
      if (mode === 'indexeddb') {
        try { await idbPut(db, 'categories', record); return true; }
        catch (err) { await degradeToMemory(); }
      }
      memory.categories[record.id] = record;
      return false;
    }

    async function getMeta() {
      if (mode === 'memory') return memory.meta;
      try { return await idbGet(db, 'meta', 'event'); }
      catch (err) { await degradeToMemory(); return memory.meta; }
    }

    async function putMeta(record) {
      if (mode === 'indexeddb') {
        try { await idbPut(db, 'meta', record, 'event'); return true; }
        catch (err) { await degradeToMemory(); }
      }
      memory.meta = record;
      return false;
    }

    async function exportAll() {
      const a = await getCategory('A');
      const b = await getCategory('B');
      const meta = await getMeta();
      return { categories: { A: a, B: b }, meta, exportedAt: Date.now() };
    }

    function validateImport(data) {
      if (!data || typeof data !== 'object') throw new Error('Backup file is not valid JSON object');
      if (!data.categories || !data.meta) throw new Error('Backup file is missing categories or meta');
      for (const id of ['A', 'B']) {
        const cat = data.categories[id];
        if (!cat || cat.id !== id || !Array.isArray(cat.teams) || typeof cat.results !== 'object' ||
          (cat.status !== 'registration' && cat.status !== 'live')) {
          throw new Error(`Backup file has an invalid category "${id}"`);
        }
      }
      if (typeof data.meta.title !== 'string') throw new Error('Backup file has an invalid event title');
    }

    async function importAll(data) {
      validateImport(data);
      await putCategory(data.categories.A);
      await putCategory(data.categories.B);
      await putMeta(data.meta);
    }

    return {
      init, getCategory, putCategory, getMeta, putMeta, exportAll, importAll,
      get mode() { return mode; },
    };
  }

  const DBStore = { createStore, defaultCategory, defaultMeta };
  if (typeof module !== 'undefined' && module.exports) module.exports = DBStore;
  else root.DBStore = DBStore;
})(typeof window !== 'undefined' ? window : globalThis);
