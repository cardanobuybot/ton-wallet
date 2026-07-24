// Web Push: подписка/отписка адреса + рассылка событий.
// Приватный VAPID никогда не покидает сервер. Публичный ключ отдаётся
// клиенту через GET /push/vapid-key.
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import {
  getWalletAddress,
  IMPORTABLE_VERSIONS,
  parseTransactions,
  verifyTonProof,
  type Network,
  type WalletVersion,
} from '@ton-wallet/core';
import { sql } from './db.ts';
import { fetchTransactions } from './push-poller.ts';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:mailmeinbox@inbox.lv';
const DOMAIN = process.env.TONPROOF_DOMAIN ?? 'grampocket.com';
const PROOF_WINDOW_SECONDS = 5 * 60;

if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

interface AuthPayload {
  address: string;
  publicKeyHex: string;
  walletVersion: string;
  network: string;
  timestamp: number;
  signatureBase64: string;
}

interface SubscribeBody extends AuthPayload {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

function normalizeRaw(address: string): string {
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address.trim());
  if (!m) throw Object.assign(new Error('Ожидался raw-адрес'), { statusCode: 400 });
  return `${m[1]}:${m[2]!.toLowerCase()}`;
}

function requireDb() {
  const s = sql();
  if (!s) throw Object.assign(new Error('БД не настроена'), { statusCode: 503 });
  return s;
}

function requireVapid() {
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    throw Object.assign(new Error('VAPID keys не настроены'), { statusCode: 503 });
  }
}

function authorize(payload: AuthPayload, proofPayload: string): string {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - payload.timestamp) > PROOF_WINDOW_SECONDS) {
    throw Object.assign(new Error('Proof устарел'), { statusCode: 400 });
  }
  if (payload.network !== 'testnet' && payload.network !== 'mainnet') {
    throw Object.assign(new Error('Неверная сеть'), { statusCode: 400 });
  }
  if (!(IMPORTABLE_VERSIONS as readonly string[]).includes(payload.walletVersion)) {
    throw Object.assign(new Error('Неизвестная версия кошелька'), { statusCode: 400 });
  }
  const network = payload.network as Network;
  const version = payload.walletVersion as WalletVersion;
  const publicKey = Buffer.from(payload.publicKeyHex, 'hex');
  if (publicKey.length !== 32) {
    throw Object.assign(new Error('publicKey длиной != 32'), { statusCode: 400 });
  }
  const derived = getWalletAddress({ publicKey }, { version, network });
  const claimedRaw = normalizeRaw(payload.address);
  if (derived.raw !== claimedRaw) {
    throw Object.assign(new Error('publicKey не соответствует адресу'), { statusCode: 400 });
  }
  const ok = verifyTonProof({
    address: claimedRaw,
    publicKeyHex: payload.publicKeyHex,
    domain: DOMAIN,
    payload: proofPayload,
    timestamp: payload.timestamp,
    signatureBase64: payload.signatureBase64,
  });
  if (!ok) throw Object.assign(new Error('Подпись proof не сходится'), { statusCode: 400 });
  return claimedRaw;
}

export interface PushEvent {
  title: string;
  body: string;
  /** URL-хеш, куда открывать при клике (например `#/u/<addr>` или ''). */
  url?: string;
  /** Уникальный тег события: одинаковые пуши схлопываются. */
  tag?: string;
}

/** Рассылает push всем подпискам, привязанным к адресу. */
export async function pushToAddress(addressRaw: string, event: PushEvent): Promise<void> {
  const s = sql();
  if (!s || !PUBLIC_KEY || !PRIVATE_KEY) return;
  const rows = await s<
    { endpoint: string; p256dh: string; auth_key: string }[]
  >`SELECT endpoint, p256dh, auth_key FROM push_subscriptions WHERE address_raw = ${addressRaw}`;
  if (rows.length === 0) {
    console.warn('[push] pushToAddress: no active subscriptions for', addressRaw);
    return;
  }
  await Promise.allSettled(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth_key } },
          JSON.stringify(event),
          { TTL: 60 * 60 * 24 },
        );
        console.log('[push] sent', addressRaw.slice(0, 10) + '…', 'title:', event.title);
      } catch (err: unknown) {
        // 404/410 = подписка мертва, удаляем.
        const status = (err as { statusCode?: number }).statusCode;
        const body = (err as { body?: string }).body;
        if (status === 404 || status === 410) {
          await s`DELETE FROM push_subscriptions WHERE endpoint = ${r.endpoint}`;
          console.warn('[push] dead subscription removed', r.endpoint.slice(0, 60));
        } else {
          // Любые другие ошибки раньше глотались — из-за этого нельзя было
          // отличить «пуш не пришёл, потому что не отправили» от «пуш отправили,
          // но провайдер вернул 5xx». Теперь логируем.
          console.error(
            '[push] sendNotification failed:',
            'status=', status ?? 'n/a',
            '| endpoint:', r.endpoint.slice(0, 60),
            '| err:', err instanceof Error ? err.message : String(err),
            body ? '| body: ' + String(body).slice(0, 200) : '',
          );
        }
      }
    }),
  );
}

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/push/vapid-key', async (_req, reply) => {
    if (!PUBLIC_KEY) return reply.code(503).send({ error: 'VAPID не настроен' });
    return { publicKey: PUBLIC_KEY };
  });

  app.post<{ Body: SubscribeBody }>('/push/subscribe', async (request) => {
    requireVapid();
    const sub = request.body.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw Object.assign(new Error('subscription неполный'), { statusCode: 400 });
    }
    const addressRaw = authorize(request.body, `push-subscribe:${sub.endpoint}`);
    const s = requireDb();
    await s`INSERT INTO push_subscriptions (address_raw, endpoint, p256dh, auth_key)
            VALUES (${addressRaw}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
            ON CONFLICT (address_raw, endpoint) DO UPDATE
              SET p256dh = EXCLUDED.p256dh,
                  auth_key = EXCLUDED.auth_key`;
    console.log('[push] subscribed', addressRaw, 'endpoint:', sub.endpoint.slice(0, 60));

    // Инициализируем курсор пуллера сразу на subscribe, а не в первом
    // тике поллера. Иначе tx, пришедшая в узком окне «subscribe → первый
    // тик» (до 20с), попадает в maxLt-init и пуш по ней не уходит.
    try {
      const existing = await s<
        { last_lt: string }[]
      >`SELECT last_lt FROM push_cursors WHERE address_raw = ${addressRaw}`;
      if (existing.length === 0) {
        const raw = await fetchTransactions(addressRaw);
        const items = parseTransactions(raw, 'testnet');
        let maxLt = 0n;
        for (const t of items) {
          const lt = BigInt(t.lt);
          if (lt > maxLt) maxLt = lt;
        }
        if (maxLt > 0n) {
          await s`INSERT INTO push_cursors (address_raw, last_lt)
                  VALUES (${addressRaw}, ${maxLt.toString()})
                  ON CONFLICT (address_raw) DO NOTHING`;
          console.log('[push] cursor initialized', addressRaw, 'lt:', maxLt.toString());
        }
      }
    } catch (err) {
      // Не критично — если не смогли инициализировать сейчас, первый тик
      // поллера сделает это через ≤20с (со старой race-семантикой).
      console.warn('[push] cursor init failed:', err instanceof Error ? err.message : err);
    }

    // Welcome-пуш: сразу подтверждаем пользователю что канал работает.
    // Если провайдер (FCM/APNs) вернёт ошибку — увидим её в логах.
    await pushToAddress(addressRaw, {
      title: '🔔 Уведомления включены',
      body: 'Будем присылать пуши о входящих и исходящих транзакциях.',
      tag: 'welcome',
    });

    return { ok: true };
  });

  // Диагностический readonly-эндпоинт: сколько подписок и какое состояние
  // курсоров у пуллера. Публичный (никаких секретов не отдаёт), но полезен
  // для быстрой проверки состояния после subscribe. При отсутствии БД → 503.
  app.get('/push/status', async () => {
    const s = requireDb();
    const subs = await s<{ address_raw: string; endpoint_short: string }[]>`
      SELECT address_raw, LEFT(endpoint, 60) AS endpoint_short
        FROM push_subscriptions ORDER BY created_at DESC LIMIT 20`;
    const cursors = await s<{ address_raw: string; last_lt: string; updated_at: string }[]>`
      SELECT address_raw, last_lt, updated_at
        FROM push_cursors ORDER BY updated_at DESC LIMIT 20`;
    return { subs, cursors, now: new Date().toISOString() };
  });

  app.post<{ Body: AuthPayload & { endpoint: string } }>(
    '/push/unsubscribe',
    async (request) => {
      const { endpoint } = request.body;
      if (!endpoint) {
        throw Object.assign(new Error('endpoint обязателен'), { statusCode: 400 });
      }
      const addressRaw = authorize(request.body, `push-unsubscribe:${endpoint}`);
      const s = requireDb();
      await s`DELETE FROM push_subscriptions
              WHERE address_raw = ${addressRaw} AND endpoint = ${endpoint}`;
      return { ok: true };
    },
  );
}
