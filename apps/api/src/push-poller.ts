// Фоновый пуллер: раз в PUSH_POLL_MS секунд смотрит toncenter по адресам,
// у которых есть push-подписки, диффит по последнему lt и рассылает
// уведомления через pushToAddress. Также рассылает уведомления
// подписчикам (кто follows этот адрес) — «@name ↑ отправил / ↓ получил».

import { formatTokenAmount, formatTonAmount, parseTransactions } from '@ton-wallet/core';
import type { TxHistoryItem } from '@ton-wallet/core';
import { sql } from './db.ts';
import { pushToAddress, type PushEvent } from './push.ts';

const POLL_MS = Number(process.env.PUSH_POLL_MS ?? 20_000);
const NETWORK = 'testnet' as const;

// Ограничиваемся окном последних 20 tx на адрес за один прогон — этого
// достаточно с запасом при интервале в 20 сек.
const HISTORY_LIMIT = 20;

async function fetchTransactions(rawAddress: string): Promise<unknown> {
  const base = process.env.TONCENTER_BASE ?? 'https://testnet.toncenter.com/api/v2';
  const key = process.env.TONCENTER_API_KEY;
  const url =
    `${base}/getTransactions?address=${encodeURIComponent(rawAddress)}&limit=${HISTORY_LIMIT}&archival=false`;
  const res = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { ok: boolean; result?: unknown };
  return data.ok ? (data.result ?? []) : [];
}

function shortAddr(friendly: string): string {
  return friendly.length > 12 ? `${friendly.slice(0, 6)}…${friendly.slice(-4)}` : friendly;
}

interface JettonMeta {
  symbol: string | null;
  decimals: number;
}

// Кэш метаданных по адресу джеттон-кошелька. Метаданные мастера практически
// неизменяемы, поэтому кэшируем без TTL; null = «кошелёк не найден» тоже кэшируется.
const jettonMetaCache = new Map<string, JettonMeta | null>();
const JETTON_META_CACHE_MAX = 1000;

interface V3JettonWallets {
  jetton_wallets?: Array<{ address: string; jetton: string }>;
  metadata?: Record<
    string,
    { token_info?: Array<{ type: string; symbol?: string; extra?: { decimals?: string | number } }> }
  >;
}

async function jettonMeta(jettonWallet: string): Promise<JettonMeta | null> {
  const cached = jettonMetaCache.get(jettonWallet);
  if (cached !== undefined) return cached;
  const base = process.env.TONCENTER_V3_BASE ?? 'https://testnet.toncenter.com/api/v3';
  const key = process.env.TONCENTER_API_KEY;
  let meta: JettonMeta | null;
  try {
    const res = await fetch(
      `${base}/jetton/wallets?address=${encodeURIComponent(jettonWallet)}&limit=1`,
      {
        headers: { ...(key ? { 'x-api-key': key } : {}) },
        signal: AbortSignal.timeout(10_000),
      },
    );
    // Сетевые/серверные сбои не кэшируем — попробуем в следующий тик.
    if (!res.ok) return null;
    const data = (await res.json()) as V3JettonWallets;
    const w = data.jetton_wallets?.[0];
    const info = w
      ? data.metadata?.[w.jetton]?.token_info?.find((t) => t.type === 'jetton_masters')
      : undefined;
    if (!w) {
      meta = null;
    } else {
      const d = Number(info?.extra?.decimals ?? 9);
      meta = {
        symbol: info?.symbol ?? null,
        decimals: Number.isInteger(d) && d >= 0 && d <= 255 ? d : 9,
      };
    }
  } catch {
    return null;
  }
  if (jettonMetaCache.size >= JETTON_META_CACHE_MAX) jettonMetaCache.clear();
  jettonMetaCache.set(jettonWallet, meta);
  return meta;
}

function jettonAmountText(t: TxHistoryItem, meta: JettonMeta | null): string {
  if (!t.jetton) return '';
  if (!meta) return `${t.jetton.amount} ед. джеттона`;
  return `${formatTokenAmount(t.jetton.amount, meta.decimals)} ${meta.symbol ?? 'ед.'}`;
}

function eventForOwn(t: TxHistoryItem, meta: JettonMeta | null): PushEvent | null {
  const arrow = t.direction === 'in' ? '↓' : '↑';
  const cp = t.counterparty ? shortAddr(t.counterparty.friendly) : '?';
  const amount = t.jetton ? jettonAmountText(t, meta) : `${formatTonAmount(t.amount)} GRAM`;
  return {
    title: `${arrow} ${amount}`,
    body: t.direction === 'in' ? `от ${cp}` : `→ ${cp}`,
    url: t.counterparty ? `#/u/${encodeURIComponent(t.counterparty.raw)}` : '',
    tag: `own:${t.hash}`,
  };
}

function eventForFollower(
  t: TxHistoryItem,
  targetShort: string,
  meta: JettonMeta | null,
): PushEvent | null {
  const arrow = t.direction === 'in' ? '↓' : '↑';
  const amount = t.jetton ? jettonAmountText(t, meta) : `${formatTonAmount(t.amount)} GRAM`;
  return {
    title: `${targetShort} ${arrow} ${amount}`,
    body: t.counterparty
      ? t.direction === 'in'
        ? `от ${shortAddr(t.counterparty.friendly)}`
        : `→ ${shortAddr(t.counterparty.friendly)}`
      : '',
    url: '',
    tag: `follow:${t.hash}`,
  };
}

async function loadCursor(s: ReturnType<typeof sql>, addr: string): Promise<bigint | null> {
  if (!s) return null;
  const rows = await s<{ last_lt: string }[]>`SELECT last_lt FROM push_cursors WHERE address_raw = ${addr}`;
  const v = rows[0]?.last_lt;
  return v ? BigInt(v) : null;
}

async function saveCursor(s: ReturnType<typeof sql>, addr: string, lt: bigint): Promise<void> {
  if (!s) return;
  await s`INSERT INTO push_cursors (address_raw, last_lt) VALUES (${addr}, ${lt.toString()})
          ON CONFLICT (address_raw) DO UPDATE SET last_lt = EXCLUDED.last_lt, updated_at = NOW()`;
}

async function followerAddresses(
  s: ReturnType<typeof sql>,
  targetRaw: string,
): Promise<string[]> {
  if (!s) return [];
  const rows = await s<
    { follower_raw: string }[]
  >`SELECT follower_raw FROM follows WHERE target_raw = ${targetRaw}`;
  return rows.map((r) => r.follower_raw);
}

function targetLabel(raw: string): string {
  return shortAddr(raw);
}

async function processAddress(addressRaw: string, subscriberCount: number): Promise<void> {
  const s = sql();
  if (!s) return;
  const cursor = await loadCursor(s, addressRaw);
  const raw = await fetchTransactions(addressRaw);
  let items: TxHistoryItem[];
  try {
    items = parseTransactions(raw, NETWORK);
  } catch {
    return;
  }
  if (items.length === 0) return;

  const fresh = cursor === null ? [] : items.filter((t) => BigInt(t.lt) > cursor);
  const maxLt = items.reduce((acc, t) => (BigInt(t.lt) > acc ? BigInt(t.lt) : acc), 0n);
  if (maxLt > 0n) await saveCursor(s, addressRaw, maxLt);
  // Первый прогон: не спамим бэк-каталогом, только фиксируем курсор.
  if (cursor === null) return;

  const followers = await followerAddresses(s, addressRaw);
  const nick = followers.length > 0 ? targetLabel(addressRaw) : '';

  // Разошлём в обратном порядке, чтобы свежайшая приходила последней.
  for (const t of fresh.slice().reverse()) {
    const meta = t.jetton ? await jettonMeta(t.jetton.jettonWallet) : null;
    // Владельцу — если у него есть push-подписки.
    if (subscriberCount > 0) {
      const evt = eventForOwn(t, meta);
      if (evt) await pushToAddress(addressRaw, evt);
    }
    // Подписчикам.
    if (followers.length > 0) {
      const evt = eventForFollower(t, nick, meta);
      if (evt) {
        await Promise.allSettled(followers.map((f) => pushToAddress(f, evt)));
      }
    }
  }
}

async function pollOnce(): Promise<void> {
  const s = sql();
  if (!s) return;
  // Все адреса, у которых есть свои подписки ИЛИ на них следят.
  const rows = await s<
    { address_raw: string; subs: string; followed: string }[]
  >`
    WITH subs_cnt AS (
      SELECT address_raw, COUNT(*) AS n
        FROM push_subscriptions GROUP BY address_raw
    ),
    followed AS (
      SELECT DISTINCT target_raw AS address_raw FROM follows
    )
    SELECT COALESCE(s.address_raw, f.address_raw) AS address_raw,
           COALESCE(s.n::text, '0') AS subs,
           CASE WHEN f.address_raw IS NULL THEN 'no' ELSE 'yes' END AS followed
      FROM subs_cnt s
      FULL OUTER JOIN followed f ON s.address_raw = f.address_raw
  `;

  for (const r of rows) {
    if (!r.address_raw) continue;
    try {
      await processAddress(r.address_raw, Number(r.subs));
    } catch (err) {
      console.error('[push-poller]', r.address_raw, err instanceof Error ? err.message : err);
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function startPushPoller(): void {
  if (!process.env.DATABASE_URL || !process.env.VAPID_PUBLIC_KEY) return;
  const tick = async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[push-poller] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      timer = setTimeout(tick, POLL_MS);
    }
  };
  // Первая итерация с задержкой, чтобы дать миграциям встать.
  timer = setTimeout(tick, 5_000);
}

export function stopPushPoller(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
