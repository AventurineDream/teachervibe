/**
 * IndexedDB persistence. Browser-local by design (Phase 1 boundary): annotations
 * live here and leave only through explicit JSON export. No server, no sync.
 *
 * Schema (DB version 1):
 *   annotations: keyPath id, index byRepo on anchor.repoId
 *   kv:          misc session state (last opened repo, tray order)
 * Trail entries are session-scoped and kept in memory, not persisted.
 */

import type { Annotation } from '../contracts/schema.js';

const DB_NAME = 'reader-store';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens (once per page, cached) the `reader-store` database, creating stores on first use. Rejects with the IndexedDB error. */
export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('annotations')) {
        const store = db.createObjectStore('annotations', { keyPath: 'id' });
        store.createIndex('byRepo', 'anchor.repoId', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
  });
  return dbPromise;
}

/** Runs one request in its own transaction on `store` and resolves with its result. */
function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
  });
}

/** Inserts or replaces an annotation by `id`. */
export async function putAnnotation(
  db: IDBDatabase,
  annotation: Annotation
): Promise<void> {
  await tx(db, 'annotations', 'readwrite', (s) => s.put(annotation));
}

/** Deletes the annotation with `id`; succeeds even if it does not exist. */
export async function deleteAnnotation(
  db: IDBDatabase,
  id: string
): Promise<void> {
  await tx(db, 'annotations', 'readwrite', (s) => s.delete(id));
}

/** The annotation with `id`, or undefined. */
export async function getAnnotation(
  db: IDBDatabase,
  id: string
): Promise<Annotation | undefined> {
  return tx(
    db,
    'annotations',
    'readonly',
    (s) => s.get(id) as IDBRequest<Annotation | undefined>
  );
}

/** Annotations whose `anchor.repoId` equals `repoId`. */
export async function listAnnotations(
  db: IDBDatabase,
  repoId: string
): Promise<Annotation[]> {
  return tx(
    db,
    'annotations',
    'readonly',
    (s) => s.index('byRepo').getAll(repoId) as IDBRequest<Annotation[]>
  );
}

/** Every stored annotation across all repositories. */
export async function listAllAnnotations(
  db: IDBDatabase
): Promise<Annotation[]> {
  return tx(
    db,
    'annotations',
    'readonly',
    (s) => s.getAll() as IDBRequest<Annotation[]>
  );
}

/** Upserts all `annotations` in one transaction (all or none); resolves with the count written. Existing ids are overwritten. */
export async function importAnnotationBatch(
  db: IDBDatabase,
  annotations: Annotation[]
): Promise<number> {
  const t = db.transaction('annotations', 'readwrite');
  const store = t.objectStore('annotations');
  for (const a of annotations) store.put(a);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(annotations.length);
    t.onerror = () => reject(t.error as Error);
  });
}

/** Stores `value` under `key` in the key/value store, replacing any previous value. */
export async function kvSet(
  db: IDBDatabase,
  key: string,
  value: unknown
): Promise<void> {
  await tx(db, 'kv', 'readwrite', (s) => s.put(value, key));
}

/** The value stored under `key`, or undefined. */
export async function kvGet<T>(
  db: IDBDatabase,
  key: string
): Promise<T | undefined> {
  return tx(
    db,
    'kv',
    'readonly',
    (s) => s.get(key) as IDBRequest<T | undefined>
  );
}
