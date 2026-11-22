import type { Kv } from "./pacer.ts";

/**
 * IndexedDB key-value store in the extension origin. Holds the wrapped client key, the pinned
 * desktop key, and daily page counts. Never post content, cookies, or tokens (SEC-04).
 */
export function idbKv(name = "citspark", store = "kv"): Kv {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
    db.then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const tx = d.transaction(store, mode);
          const req = f(tx.objectStore(store));
          tx.oncomplete = () => resolve(req.result as T);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  return {
    get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)),
    set: (key, value) => run<void>("readwrite", (s) => s.put(value, key)).then(() => undefined),
  };
}
