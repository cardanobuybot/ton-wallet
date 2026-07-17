// В IndexedDB попадает ТОЛЬКО шифртекст-конверт (KeystoreEnvelope).
// Расшифрованная мнемоника и ключи живут исключительно в памяти вкладки.
import type { KeystoreEnvelope } from '@ton-wallet/core';

const DB_NAME = 'ton-wallet';
const STORE = 'keystore';
const KEY = 'envelope';
// Адресная книга: только метки и адреса (публичные данные), ключ — raw-адрес
const BOOK_STORE = 'address-book';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE);
    };
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
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  await Promise.all([request(store.delete(KEY)), request(store.delete(VERSION_KEY))]);
  db.close();
}

// Версия контракта кошелька (v5r1/v4r2/v3r2) — публичная настройка, не секрет
const VERSION_KEY = 'walletVersion';

export async function saveWalletVersion(version: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(version, VERSION_KEY));
  db.close();
}

export async function loadWalletVersion(): Promise<string | null> {
  const db = await openDb();
  const result = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(VERSION_KEY));
  db.close();
  return (result as string | undefined) ?? null;
}

export interface AddressBookEntry {
  raw: string;
  friendly: string;
  label: string;
}

export async function listAddressBook(): Promise<AddressBookEntry[]> {
  const db = await openDb();
  const result = await request(
    db.transaction(BOOK_STORE, 'readonly').objectStore(BOOK_STORE).getAll(),
  );
  db.close();
  return result as AddressBookEntry[];
}

export async function saveAddressBookEntry(entry: AddressBookEntry): Promise<void> {
  const db = await openDb();
  await request(
    db.transaction(BOOK_STORE, 'readwrite').objectStore(BOOK_STORE).put(entry, entry.raw),
  );
  db.close();
}

export async function deleteAddressBookEntry(raw: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(BOOK_STORE, 'readwrite').objectStore(BOOK_STORE).delete(raw));
  db.close();
}
