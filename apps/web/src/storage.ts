// В IndexedDB попадает ТОЛЬКО шифртекст-конверт (KeystoreEnvelope).
// Расшифрованная мнемоника и ключи живут исключительно в памяти вкладки.
import type { KeystoreEnvelope, TonConnectSession } from '@ton-wallet/core';

const DB_NAME = 'ton-wallet';
const STORE = 'keystore';
// Мультикошелёк (v5): вместо одиночного 'envelope' — массив StoredWallet
// под ключом 'wallets', плюс 'activeId' указывает на активный. Легаси-ключи
// 'envelope' и 'walletVersion' автомигрируются в один StoredWallet в
// onupgradeneeded — так что существующим юзерам ничего не надо делать.
const WALLETS_KEY = 'wallets';
const ACTIVE_ID_KEY = 'activeId';
// Легаси-ключи, оставлены только для миграции.
const LEGACY_ENV_KEY = 'envelope';
const LEGACY_VERSION_KEY = 'walletVersion';
// Адресная книга: только метки и адреса (публичные данные), ключ — raw-адрес
const BOOK_STORE = 'address-book';
// TON Connect: сессии моста (x25519 сессионные ключи, НЕ ключи кошелька), ключ — client_id dApp
const TC_STORE = 'tonconnect';
// Избранные адреса (публичные данные), ключ — raw-адрес
const FAV_STORE = 'favorites';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 5);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE);
      if (!db.objectStoreNames.contains(TC_STORE)) db.createObjectStore(TC_STORE);
      if (!db.objectStoreNames.contains(FAV_STORE)) db.createObjectStore(FAV_STORE);

      // v4 → v5: миграция единичного envelope → массив wallets. Идемпотентно.
      const oldVersion = event.oldVersion ?? 0;
      if (oldVersion > 0 && oldVersion < 5) {
        const store = tx.objectStore(STORE);
        const envReq = store.get(LEGACY_ENV_KEY);
        envReq.onsuccess = () => {
          const legacyEnv = envReq.result as KeystoreEnvelope | undefined;
          if (!legacyEnv) return;
          const verReq = store.get(LEGACY_VERSION_KEY);
          verReq.onsuccess = () => {
            const legacyVer = (verReq.result as string | undefined) ?? 'v5r1';
            const id = makeId();
            const wallet: StoredWallet = {
              id,
              label: 'Мой кошелёк',
              envelope: legacyEnv,
              version: legacyVer,
              createdAt: Date.now(),
            };
            store.put([wallet], WALLETS_KEY);
            store.put(id, ACTIVE_ID_KEY);
            store.delete(LEGACY_ENV_KEY);
            store.delete(LEGACY_VERSION_KEY);
          };
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Мультикошелёк API ----------

export interface StoredWallet {
  id: string;
  label: string;
  envelope: KeystoreEnvelope;
  /** WalletVersion — храним как строку, чтобы не таскать union в storage-слое. */
  version: string;
  createdAt: number;
}

export interface WalletsState {
  wallets: StoredWallet[];
  activeId: string | null;
}

export async function listWallets(): Promise<WalletsState> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const [wallets, activeId] = await Promise.all([
    request(store.get(WALLETS_KEY)),
    request(store.get(ACTIVE_ID_KEY)),
  ]);
  db.close();
  return {
    wallets: (wallets as StoredWallet[] | undefined) ?? [],
    activeId: (activeId as string | undefined) ?? null,
  };
}

/**
 * Добавить кошелёк (создание или импорт). Возвращает StoredWallet.
 * По умолчанию новый кошелёк становится активным (нормально для create-flow).
 * Пропуск через IndexedDB — атомарный put массива + activeId в одной tx.
 */
export async function addWallet(input: {
  label: string;
  envelope: KeystoreEnvelope;
  version: string;
  setActive?: boolean;
}): Promise<StoredWallet> {
  const { wallets } = await listWallets();
  const stored: StoredWallet = {
    id: makeId(),
    label: input.label,
    envelope: input.envelope,
    version: input.version,
    createdAt: Date.now(),
  };
  const next = [...wallets, stored];
  const db = await openDb();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const puts: Promise<unknown>[] = [request(store.put(next, WALLETS_KEY))];
  if (input.setActive !== false) puts.push(request(store.put(stored.id, ACTIVE_ID_KEY)));
  await Promise.all(puts);
  db.close();
  return stored;
}

export async function switchActiveWallet(id: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(id, ACTIVE_ID_KEY));
  db.close();
}

export async function renameWallet(id: string, label: string): Promise<void> {
  const { wallets } = await listWallets();
  const next = wallets.map((w) => (w.id === id ? { ...w, label } : w));
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(next, WALLETS_KEY));
  db.close();
}

/** Удаляет кошелёк. Если был активным — активным становится первый оставшийся, либо null. */
export async function removeWallet(id: string): Promise<{ activeId: string | null }> {
  const { wallets, activeId } = await listWallets();
  const next = wallets.filter((w) => w.id !== id);
  let newActive: string | null = activeId;
  if (activeId === id) newActive = next[0]?.id ?? null;
  const db = await openDb();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const ops: Promise<unknown>[] = [request(store.put(next, WALLETS_KEY))];
  if (newActive === null) ops.push(request(store.delete(ACTIVE_ID_KEY)));
  else ops.push(request(store.put(newActive, ACTIVE_ID_KEY)));
  await Promise.all(ops);
  db.close();
  return { activeId: newActive };
}

// ---------- Compat: legacy API поверх активного кошелька ----------
// Оставлено, чтобы остальной код (unlock, saveEnvelope в create-flow) мог
// плавно перейти на новую схему без one-shot переписи всего App.tsx.

export async function loadEnvelope(): Promise<KeystoreEnvelope | null> {
  const { wallets, activeId } = await listWallets();
  const w = wallets.find((x) => x.id === activeId);
  return w?.envelope ?? null;
}

export async function saveEnvelope(envelope: KeystoreEnvelope): Promise<void> {
  const { wallets, activeId } = await listWallets();
  if (activeId === null) {
    throw new Error('Нет активного кошелька для saveEnvelope — используй addWallet');
  }
  const next = wallets.map((w) => (w.id === activeId ? { ...w, envelope } : w));
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(next, WALLETS_KEY));
  db.close();
}

/** Удаляет АКТИВНЫЙ кошелёк. Если был последним — activeId → null. */
export async function deleteEnvelope(): Promise<void> {
  const { activeId } = await listWallets();
  if (activeId === null) return;
  await removeWallet(activeId);
}

export async function saveWalletVersion(version: string): Promise<void> {
  const { wallets, activeId } = await listWallets();
  if (activeId === null) return;
  const next = wallets.map((w) => (w.id === activeId ? { ...w, version } : w));
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(next, WALLETS_KEY));
  db.close();
}

export async function loadWalletVersion(): Promise<string | null> {
  const { wallets, activeId } = await listWallets();
  const w = wallets.find((x) => x.id === activeId);
  return w?.version ?? null;
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

// ---------- Избранное ----------

export interface FavoriteAddress {
  /** raw-адрес — ключ записи */
  raw: string;
  /** friendly для отображения (кэшируем, чтобы не пересобирать) */
  friendly: string;
  /** Пользовательский ярлык (опционально); при отсутствии показываем сокращённый адрес */
  label?: string;
  /** Unix-мс — сортировка «недавно добавленные» */
  addedAt: number;
}

export async function listFavorites(): Promise<FavoriteAddress[]> {
  const db = await openDb();
  const result = await request(
    db.transaction(FAV_STORE, 'readonly').objectStore(FAV_STORE).getAll(),
  );
  db.close();
  const items = result as FavoriteAddress[];
  return items.sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveFavorite(fav: FavoriteAddress): Promise<void> {
  const db = await openDb();
  await request(db.transaction(FAV_STORE, 'readwrite').objectStore(FAV_STORE).put(fav, fav.raw));
  db.close();
}

export async function deleteFavorite(raw: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(FAV_STORE, 'readwrite').objectStore(FAV_STORE).delete(raw));
  db.close();
}

export async function isFavorite(raw: string): Promise<boolean> {
  const db = await openDb();
  const result = await request(
    db.transaction(FAV_STORE, 'readonly').objectStore(FAV_STORE).get(raw),
  );
  db.close();
  return result !== undefined;
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
