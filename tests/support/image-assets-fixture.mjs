// Minimal transactional IndexedDB fixture for asset-store tests. Blob records
// use structuredClone, not JSON; readwrite transactions serialize like IDB.
import { persistSessionImages } from "../../src/shared/session/session-image-assets.js";

export function installImageAssetsFixture() {
  persistSessionImages.clear();
  const previous = globalThis.indexedDB;
  const stores = new Map();
  const counts = { opens: 0, adds: 0, puts: 0, blobBytes: 0 };
  let tail = Promise.resolve();
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, { keyPath }) {
      stores.set(name, { keyPath, rows: new Map(), indexes: new Map() });
      return { createIndex: (index, path) => stores.get(name).indexes.set(index, path) };
    },
    close() {},
    transaction(_names, mode) {
      let pending = 0, completed = false;
      const ready = tail;
      const finished = Promise.withResolvers();
      if (mode === "readwrite") tail = finished.promise;
      const tx = { objectStore: name => objectStore(stores.get(name)) };
      function request(work) {
        const req = {};
        pending++;
        ready.then(() => {
          try { req.result = work(); req.onsuccess?.(); }
          catch (error) { req.error = error; req.onerror?.(); tx.error = error; tx.onerror?.(); }
          pending--;
          setImmediate(() => {
            if (!pending && !completed) { completed = true; tx.oncomplete?.(); finished.resolve(); }
          });
        });
        return req;
      }
      function objectStore(data) {
        return {
          get: key => request(() => structuredClone(data.rows.get(key))),
          getKey: key => request(() => data.rows.has(key) ? key : undefined),
          getAll: () => request(() => structuredClone([...data.rows.values()])),
          getAllKeys: () => request(() => [...data.rows.keys()]),
          add: value => request(() => {
            const key = value[data.keyPath];
            if (data.rows.has(key)) throw new Error("ConstraintError");
            data.rows.set(key, structuredClone(value));
            counts.adds++; counts.blobBytes += value.blob?.size || 0;
            return key;
          }),
          put: value => request(() => { data.rows.set(value[data.keyPath], structuredClone(value)); counts.puts++; }),
          delete: key => request(() => data.rows.delete(key)),
          index: name => ({ get: key => request(() => structuredClone([...data.rows.values()].find(row => row[data.indexes.get(name)] === key))) }),
        };
      }
      return tx;
    },
  };
  globalThis.indexedDB = {
    open() {
      counts.opens++;
      const req = {};
      queueMicrotask(() => {
        req.result = db;
        if (!stores.size) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { stores, counts, db, dispose() { persistSessionImages.clear(); globalThis.indexedDB = previous; } };
}
