// В IndexedDB попадает ТОЛЬКО шифртекст-конверт (KeystoreEnvelope).
// Расшифрованная мнемоника и ключи живут исключительно в памяти вкладки.
import type { KeystoreEnvelope, TonConnectSession } from '@ton-wallet/core';

const DB_NAME = 'ton-wallet';
const STORE = 'keystore';
const KEY = 'envelope';
// Адресная книга: только метки и адреса (публичные данные), ключ — raw-адрес
const BOOK_STORE = 'address-book';
// TON Connect: сессии моста (x25519 сессионные ключи, НЕ ключи кошелька), ключ — client_id dApp
const TC_STORE = 'tonconnect';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE);
      if (!db.objectStoreNames.contains(TC_STORE)) db.createObjectStore(TC_STORE);
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

// Просим браузер пометить хранилище как невыселяемое: без этого IndexedDB
// с конвертом ключей может быть вычищена при нехватке места на устройстве.
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (!navigator.storage?.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
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

// ---------- TON Connect ----------

export interface TonConnectConnection {
  /** x25519-публичный ключ dApp (client_id на мосту) — ключ записи */
  dAppClientId: string;
  /** Сессионная NaCl-пара кошелька; это ключи транспорта моста, не средства */
  session: TonConnectSession;
  manifestUrl: string;
  appName: string;
  appUrl: string;
  createdAt: number;
}

export async function listTonConnectConnections(): Promise<TonConnectConnection[]> {
  const db = await openDb();
  const result = await request(db.transaction(TC_STORE, 'readonly').objectStore(TC_STORE).getAll());
  db.close();
  return result as TonConnectConnection[];
}

export async function saveTonConnectConnection(conn: TonConnectConnection): Promise<void> {
  const db = await openDb();
  await request(
    db.transaction(TC_STORE, 'readwrite').objectStore(TC_STORE).put(conn, conn.dAppClientId),
  );
  db.close();
}

export async function deleteTonConnectConnection(dAppClientId: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(TC_STORE, 'readwrite').objectStore(TC_STORE).delete(dAppClientId));
  db.close();
}

// last_event_id моста — публичный курсор, храним рядом с walletVersion
const TC_LAST_EVENT_KEY = 'tcLastEventId';

export async function saveTcLastEventId(id: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(id, TC_LAST_EVENT_KEY));
  db.close();
}

export async function loadTcLastEventId(): Promise<string | null> {
  const db = await openDb();
  const result = await request(
    db.transaction(STORE, 'readonly').objectStore(STORE).get(TC_LAST_EVENT_KEY),
  );
  db.close();
  return (result as string | undefined) ?? null;
}
