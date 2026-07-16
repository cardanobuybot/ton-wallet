// В IndexedDB попадает ТОЛЬКО шифртекст-конверт (KeystoreEnvelope).
// Расшифрованная мнемоника и ключи живут исключительно в памяти вкладки.
import type { KeystoreEnvelope } from '@ton-wallet/core';

const DB_NAME = 'ton-wallet';
const STORE = 'keystore';
const KEY = 'envelope';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveEnvelope(envelope: KeystoreEnvelope): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(envelope, KEY));
  db.close();
}

export async function loadEnvelope(): Promise<KeystoreEnvelope | null> {
  const db = await openDb();
  const result = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY));
  db.close();
  return (result as KeystoreEnvelope | undefined) ?? null;
}

export async function deleteEnvelope(): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY));
  db.close();
}
