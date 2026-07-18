// TON Connect v2: разбор ссылок, сессионная криптография моста (NaCl box),
// connect-событие с ton_proof и разбор запросов dApp.
// Спецификация: https://github.com/ton-blockchain/ton-connect
import nacl from 'tweetnacl';
import { Address, beginCell, storeStateInit } from '@ton/core';
import { sha256_sync, sign, signVerify } from '@ton/crypto';
import type { KeyPair } from '@ton/crypto';
import { getWalletContract } from './wallet.ts';
import type { Network, WalletVersion } from './wallet.ts';

export const TONCONNECT_PROTOCOL_VERSION = 2;
/** Максимум сообщений в одном sendTransaction, который мы объявляем в device.features */
export const TONCONNECT_MAX_MESSAGES = 4;

const NETWORK_IDS: Record<Network, string> = { mainnet: '-239', testnet: '-3' };

// ---------- hex-помощники ----------

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ---------- разбор ссылки tc:// ----------

export type ConnectItem = { name: 'ton_addr' } | { name: 'ton_proof'; payload: string };

export interface TonConnectLink {
  version: number;
  /** x25519-публичный ключ dApp, hex (32 байта) — client_id dApp на мосту */
  dAppClientId: string;
  manifestUrl: string;
  items: ConnectItem[];
}

/** Понимает tc://… и universal-ссылки https://…?v=2&id=…&r=… */
export function parseTonConnectLink(link: string): TonConnectLink {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error('Не похоже на ссылку TON Connect');
  }
  const v = url.searchParams.get('v');
  const id = url.searchParams.get('id');
  const r = url.searchParams.get('r');
  if (!v || !id || !r) {
    throw new Error('В ссылке нет обязательных параметров v, id, r');
  }
  const version = Number(v);
  if (version !== TONCONNECT_PROTOCOL_VERSION) {
    throw new Error(`Неподдерживаемая версия TON Connect: ${v}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(id)) {
    throw new Error('id должен быть 32-байтовым hex-ключом');
  }
  let request: unknown;
  try {
    request = JSON.parse(r);
  } catch {
    throw new Error('Параметр r — не валидный JSON');
  }
  const req = request as { manifestUrl?: unknown; items?: unknown };
  if (typeof req.manifestUrl !== 'string' || !req.manifestUrl.startsWith('https://')) {
    throw new Error('manifestUrl отсутствует или не https');
  }
  const rawItems = Array.isArray(req.items) ? (req.items as { name?: unknown; payload?: unknown }[]) : [];
  const items: ConnectItem[] = [];
  for (const it of rawItems) {
    if (it.name === 'ton_addr') items.push({ name: 'ton_addr' });
    else if (it.name === 'ton_proof' && typeof it.payload === 'string')
      items.push({ name: 'ton_proof', payload: it.payload });
  }
  if (!items.some((i) => i.name === 'ton_addr')) {
    throw new Error('Запрос без ton_addr не имеет смысла');
  }
  return { version, dAppClientId: id.toLowerCase(), manifestUrl: req.manifestUrl, items };
}

// ---------- сессионная криптография моста ----------

/** Сессия хранится в hex — удобно класть в IndexedDB */
export interface TonConnectSession {
  /** Наш client_id на мосту */
  publicKeyHex: string;
  secretKeyHex: string;
}

export function createSession(): TonConnectSession {
  const kp = nacl.box.keyPair();
  return { publicKeyHex: bytesToHex(kp.publicKey), secretKeyHex: bytesToHex(kp.secretKey) };
}

/** base64(nonce24 ++ nacl.box(utf8(json))) — формат сообщений моста */
export function encryptBridgeMessage(
  json: string,
  dAppClientId: string,
  session: TonConnectSession,
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(
    new TextEncoder().encode(json),
    nonce,
    hexToBytes(dAppClientId),
    hexToBytes(session.secretKeyHex),
  );
  const out = new Uint8Array(nonce.length + boxed.length);
  out.set(nonce);
  out.set(boxed, nonce.length);
  return Buffer.from(out).toString('base64');
}

/** Обратная операция; битый шифротекст или чужой ключ → throw */
export function decryptBridgeMessage(
  base64: string,
  dAppClientId: string,
  session: TonConnectSession,
): string {
  const data = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (data.length <= nacl.box.nonceLength) {
    throw new Error('Сообщение моста слишком короткое');
  }
  const nonce = data.subarray(0, nacl.box.nonceLength);
  const boxed = data.subarray(nacl.box.nonceLength);
  const opened = nacl.box.open(
    boxed,
    nonce,
    hexToBytes(dAppClientId),
    hexToBytes(session.secretKeyHex),
  );
  if (!opened) {
    throw new Error('Не удалось расшифровать сообщение моста');
  }
  return new TextDecoder().decode(opened);
}

// ---------- ton_proof ----------

export interface BuildTonProofParams {
  /** ed25519-пара кошелька (подписываем secretKey) */
  keyPair: KeyPair;
  /** Адрес кошелька (raw или friendly) */
  address: string;
  /** Домен dApp без схемы, напр. "app.example.com" */
  domain: string;
  /** payload из запроса ton_proof */
  payload: string;
  /** unix-секунды; параметр — ради детерминированных тестов */
  timestamp?: number;
}

export interface TonProofReply {
  name: 'ton_proof';
  proof: {
    timestamp: number;
    domain: { lengthBytes: number; value: string };
    signature: string;
    payload: string;
  };
}

/**
 * message  = "ton-proof-item-v2/" ++ wc(int32 BE) ++ addrHash(32)
 *            ++ domainLen(uint32 LE) ++ domain ++ timestamp(uint64 LE) ++ payload
 * подпись  = ed25519(sha256(0xffff ++ "ton-connect" ++ sha256(message)))
 */
export function buildTonProof(params: BuildTonProofParams): TonProofReply {
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
  const addr = Address.parse(params.address);
  const domainBytes = new TextEncoder().encode(params.domain);
  const payloadBytes = new TextEncoder().encode(params.payload);

  const wc = Buffer.alloc(4);
  wc.writeInt32BE(addr.workChain);
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBytes.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestamp));

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    wc,
    addr.hash,
    domainLen,
    domainBytes,
    ts,
    payloadBytes,
  ]);
  const toSign = sha256_sync(
    Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256_sync(message)]),
  );
  const signature = sign(toSign, params.keyPair.secretKey).toString('base64');
  return {
    name: 'ton_proof',
    proof: {
      timestamp,
      domain: { lengthBytes: domainBytes.length, value: params.domain },
      signature,
      payload: params.payload,
    },
  };
}

export interface VerifyTonProofParams {
  /** raw или friendly адрес, которому принадлежит публичный ключ */
  address: string;
  /** hex 32B ed25519 публичного ключа кошелька, подписавшего proof */
  publicKeyHex: string;
  /** Домен, к которому привязан proof (напр. "grampocket.com") */
  domain: string;
  /** Payload, зашитый в proof (для нашего сервера — типа `register:@name`) */
  payload: string;
  /** timestamp из proof (unix-секунды) */
  timestamp: number;
  /** base64 подписи из proof */
  signatureBase64: string;
}

/**
 * Обратка к buildTonProof: собирает тот же message и проверяет подпись.
 * НЕ проверяет ни срок годности timestamp, ни соответствие publicKey→address —
 * это политика вызывающего кода (сервер сам решает окно и версию кошелька).
 */
export function verifyTonProof(params: VerifyTonProofParams): boolean {
  const addr = Address.parse(params.address);
  const publicKey = Buffer.from(params.publicKeyHex, 'hex');
  if (publicKey.length !== 32) return false;
  const signature = Buffer.from(params.signatureBase64, 'base64');
  if (signature.length !== 64) return false;

  const domainBytes = new TextEncoder().encode(params.domain);
  const payloadBytes = new TextEncoder().encode(params.payload);
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(addr.workChain);
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBytes.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(params.timestamp));

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    wc,
    addr.hash,
    domainLen,
    domainBytes,
    ts,
    payloadBytes,
  ]);
  const toSign = sha256_sync(
    Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256_sync(message)]),
  );
  return signVerify(toSign, signature, publicKey);
}

// ---------- connect-событие ----------

export interface BuildConnectEventParams {
  /** id события — по протоколу монотонный счётчик кошелька */
  id: number;
  keyPair: KeyPair;
  version: WalletVersion;
  network: Network;
  items: ConnectItem[];
  /** Домен dApp — нужен, если среди items есть ton_proof */
  domain?: string;
  appName: string;
  appVersion: string;
  timestamp?: number;
}

export function buildConnectEvent(params: BuildConnectEventParams): object {
  const wallet = getWalletContract(params.keyPair, {
    version: params.version,
    network: params.network,
  });
  const stateInit = beginCell().store(storeStateInit(wallet.init)).endCell();
  const replyItems: object[] = [];
  for (const item of params.items) {
    if (item.name === 'ton_addr') {
      replyItems.push({
        name: 'ton_addr',
        address: wallet.address.toRawString(),
        network: NETWORK_IDS[params.network],
        publicKey: bytesToHex(params.keyPair.publicKey),
        walletStateInit: stateInit.toBoc().toString('base64'),
      });
    } else {
      if (!params.domain) {
        throw new Error('Для ton_proof нужен домен dApp');
      }
      replyItems.push(
        buildTonProof({
          keyPair: params.keyPair,
          address: wallet.address.toRawString(),
          domain: params.domain,
          payload: item.payload,
          ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        }),
      );
    }
  }
  return {
    event: 'connect',
    id: params.id,
    payload: {
      items: replyItems,
      device: {
        platform: 'browser',
        appName: params.appName,
        appVersion: params.appVersion,
        maxProtocolVersion: TONCONNECT_PROTOCOL_VERSION,
        features: [{ name: 'SendTransaction', maxMessages: TONCONNECT_MAX_MESSAGES }],
      },
    },
  };
}

export function buildConnectError(id: number, code: number, message: string): object {
  return { event: 'connect_error', id, payload: { code, message } };
}

// ---------- запросы dApp ----------

/** Код ошибки «пользователь отклонил» по спецификации */
export const TONCONNECT_USER_DECLINED = 300;

export interface SendTransactionMessage {
  address: string;
  /** нанотоны */
  amount: bigint;
  /** base64 BOC тела сообщения */
  payload?: string;
  /** base64 BOC stateInit получателя */
  stateInit?: string;
}

export interface SendTransactionRequest {
  id: string;
  validUntil?: number;
  /** '-239' | '-3', если dApp указал сеть */
  network?: string;
  messages: SendTransactionMessage[];
}

export type ParsedAppRequest =
  | { kind: 'sendTransaction'; request: SendTransactionRequest }
  | { kind: 'disconnect'; id: string }
  | { kind: 'unknown'; id: string; method: string };

/** Разбирает расшифрованное сообщение моста от dApp */
export function parseAppRequest(json: string): ParsedAppRequest {
  const raw = JSON.parse(json) as { method?: unknown; params?: unknown; id?: unknown };
  const id = String(raw.id ?? '');
  if (raw.method === 'disconnect') {
    return { kind: 'disconnect', id };
  }
  if (raw.method !== 'sendTransaction') {
    return { kind: 'unknown', id, method: String(raw.method ?? '') };
  }
  const params = Array.isArray(raw.params) ? (raw.params as unknown[]) : [];
  if (typeof params[0] !== 'string') {
    throw new Error('sendTransaction без params[0]');
  }
  const p = JSON.parse(params[0]) as {
    valid_until?: unknown;
    validUntil?: unknown;
    network?: unknown;
    messages?: unknown;
  };
  if (!Array.isArray(p.messages) || p.messages.length === 0) {
    throw new Error('sendTransaction без сообщений');
  }
  if (p.messages.length > TONCONNECT_MAX_MESSAGES) {
    throw new Error(`Слишком много сообщений: ${p.messages.length} (максимум ${TONCONNECT_MAX_MESSAGES})`);
  }
  const messages = (p.messages as { address?: unknown; amount?: unknown; payload?: unknown; stateInit?: unknown }[]).map(
    (m) => {
      if (typeof m.address !== 'string') throw new Error('Сообщение без адреса');
      Address.parse(m.address); // валидация; бросит на мусоре
      if (typeof m.amount !== 'string' && typeof m.amount !== 'number') {
        throw new Error('Сообщение без суммы');
      }
      const amount = BigInt(m.amount);
      if (amount < 0n) throw new Error('Отрицательная сумма');
      return {
        address: m.address,
        amount,
        ...(typeof m.payload === 'string' ? { payload: m.payload } : {}),
        ...(typeof m.stateInit === 'string' ? { stateInit: m.stateInit } : {}),
      };
    },
  );
  const validUntilRaw = p.valid_until ?? p.validUntil;
  const validUntil =
    typeof validUntilRaw === 'number' || typeof validUntilRaw === 'string'
      ? Number(validUntilRaw)
      : undefined;
  return {
    kind: 'sendTransaction',
    request: {
      id,
      ...(validUntil !== undefined && Number.isFinite(validUntil) ? { validUntil } : {}),
      ...(typeof p.network === 'string' ? { network: p.network } : {}),
      messages,
    },
  };
}

// ---------- ответы кошелька ----------

export function buildSendTransactionSuccess(id: string, bocBase64: string): object {
  return { result: bocBase64, id };
}

export function buildSendTransactionError(id: string, code: number, message: string): object {
  return { error: { code, message }, id };
}
