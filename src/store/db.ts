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

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
  });
}

export async function putAnnotation(db: IDBDatabase, annotation: Annotation): Promise<void> {
  await tx(db, 'annotations', 'readwrite', (s) => s.put(annotation));
}

export async function deleteAnnotation(db: IDBDatabase, id: string): Promise<void> {
  await tx(db, 'annotations', 'readwrite', (s) => s.delete(id));
}

export async function getAnnotation(db: IDBDatabase, id: string): Promise<Annotation | undefined> {
  return tx(db, 'annotations', 'readonly', (s) => s.get(id) as IDBRequest<Annotation | undefined>);
}

export async function listAnnotations(db: IDBDatabase, repoId: string): Promise<Annotation[]> {
  return tx(db, 'annotations', 'readonly', (s) => s.index('byRepo').getAll(repoId) as IDBRequest<Annotation[]>);
}

export async function listAllAnnotations(db: IDBDatabase): Promise<Annotation[]> {
  return tx(db, 'annotations', 'readonly', (s) => s.getAll() as IDBRequest<Annotation[]>);
}

export async function importAnnotationBatch(db: IDBDatabase, annotations: Annotation[]): Promise<number> {
  const t = db.transaction('annotations', 'readwrite');
  const store = t.objectStore('annotations');
  for (const a of annotations) store.put(a);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(annotations.length);
    t.onerror = () => reject(t.error as Error);
  });
}

export async function kvSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  await tx(db, 'kv', 'readwrite', (s) => s.put(value, key));
}

export async function kvGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return tx(db, 'kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}
