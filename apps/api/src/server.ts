// ПРАВИЛО ПРОЕКТА: этот сервис никогда не касается приватных ключей,
// мнемоник и подписи. Только публичные данные и уже подписанный BOC.
import Fastify from 'fastify';
import { runMigrations } from './db.ts';
import { registerSocialRoutes } from './social.ts';
import { registerPushRoutes } from './push.ts';
import { startPushPoller } from './push-poller.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const toncenterBase = process.env.TONCENTER_BASE ?? 'https://testnet.toncenter.com/api/v2';
const toncenterApiKey = process.env.TONCENTER_API_KEY;
const toncenterTimeoutMs = Number(process.env.TONCENTER_TIMEOUT_MS ?? 10_000);
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ??
  'http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173'
).split(',');

const app = Fastify({ logger: true });

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'origin');
    reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  }
  if (request.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});

async function toncenter(method: string, payload?: Record<string, unknown>): Promise<unknown> {
  const url = `${toncenterBase}/${method}`;
  const response = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(toncenterApiKey ? { 'x-api-key': toncenterApiKey } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(toncenterTimeoutMs),
  });
  const data = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok || !data.ok) {
    throw Object.assign(new Error(data.error ?? `toncenter HTTP ${response.status}`), {
      statusCode: response.status === 429 ? 429 : 502,
    });
  }
  return data.result;
}

app.get('/health', () => ({ status: 'ok' }));

app.get<{ Params: { address: string } }>('/account/:address', async (request) => {
  const info = (await toncenter(
    `getWalletInformation?address=${encodeURIComponent(request.params.address)}`,
  )) as {
    balance: string;
    account_state: string;
    seqno?: number;
  };
  return {
    balance: info.balance,
    deployed: info.account_state === 'active',
    seqno: info.seqno ?? 0,
  };
});

app.get<{
  Params: { address: string };
  Querystring: { limit?: string; lt?: string; hash?: string };
}>('/transactions/:address', async (request) => {
  const { limit, lt, hash } = request.query;
  const params = new URLSearchParams({
    address: request.params.address,
    limit: String(Math.min(Number(limit ?? 20) || 20, 50)),
    // Пагинация toncenter: lt+hash последней полученной транзакции
    ...(lt && hash ? { lt, hash } : {}),
  });
  const result = await toncenter(`getTransactions?${params.toString()}`);
  return { transactions: result };
});

const toncenterV3Base =
  process.env.TONCENTER_V3_BASE ?? 'https://testnet.toncenter.com/api/v3';

// v3 отвечает без конверта {ok, result}; ключ тот же, что у v2
async function toncenterV3(path: string): Promise<unknown> {
  const response = await fetch(`${toncenterV3Base}/${path}`, {
    headers: { ...(toncenterApiKey ? { 'x-api-key': toncenterApiKey } : {}) },
    signal: AbortSignal.timeout(toncenterTimeoutMs),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`toncenter v3 HTTP ${response.status}`), {
      statusCode: response.status === 429 ? 429 : 502,
    });
  }
  return response.json();
}

interface V3JettonWallets {
  jetton_wallets: Array<{ address: string; balance: string; jetton: string }>;
  metadata: Record<
    string,
    { token_info?: Array<{ type: string; name?: string; symbol?: string; image?: string; extra?: { decimals?: string | number } }> }
  >;
}

// Балансы джеттонов владельца (toncenter v3; v2 джеттоны не умеет)
app.get<{ Params: { address: string } }>('/jettons/:address', async (request) => {
  const data = (await toncenterV3(
    `jetton/wallets?owner_address=${encodeURIComponent(request.params.address)}` +
      '&limit=50&exclude_zero_balance=true',
  )) as V3JettonWallets;
  const jettons = data.jetton_wallets.map((w) => {
    const info = data.metadata[w.jetton]?.token_info?.find((t) => t.type === 'jetton_masters');
    const decimals = Number(info?.extra?.decimals ?? 9);
    return {
      jettonWallet: w.address,
      jettonMaster: w.jetton,
      balance: w.balance,
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : 9,
      ...(info?.symbol ? { symbol: info.symbol } : {}),
      ...(info?.name ? { name: info.name } : {}),
    };
  });
  return { jettons };
});

// Досье адреса для анти-скам карточки: только публичные данные toncenter.
// Возраст/счётчик считаем по последним 50 tx: если их ровно 50 — счётчик «50+»,
// а firstSeen — лишь нижняя граница возраста (txCountCapped=true).
app.get<{ Params: { address: string } }>('/address-intel/:address', async (request) => {
  const address = encodeURIComponent(request.params.address);
  const [info, txs] = await Promise.all([
    toncenter(`getWalletInformation?address=${address}`) as Promise<{
      balance: string;
      account_state: string;
    }>,
    toncenter(`getTransactions?address=${address}&limit=50`) as Promise<Array<{ utime: number }>>,
  ]);
  return {
    deployed: info.account_state === 'active',
    balance: info.balance,
    txCount: txs.length,
    txCountCapped: txs.length >= 50,
    firstSeen: txs.length > 0 ? txs[txs.length - 1]!.utime : null,
    lastSeen: txs.length > 0 ? txs[0]!.utime : null,
  };
});

app.post<{
  Body: { address: string; body: string; initCode?: string; initData?: string };
}>('/estimate-fee', async (request) => {
  const { address, body, initCode, initData } = request.body;
  const result = (await toncenter('estimateFee', {
    address,
    body,
    init_code: initCode ?? '',
    init_data: initData ?? '',
    // Подпись уже настоящая, но toncenter требует этот флаг для внешних сообщений
    ignore_chksig: true,
  })) as { source_fees: Record<string, number> };
  const f = result.source_fees;
  const totalFee = BigInt(f.in_fwd_fee ?? 0) + BigInt(f.storage_fee ?? 0) +
    BigInt(f.gas_fee ?? 0) + BigInt(f.fwd_fee ?? 0);
  return { totalFee: totalFee.toString(), fees: f };
});

const tonapiBase = process.env.TONAPI_BASE ?? 'https://testnet.tonapi.io';
const tonapiKey = process.env.TONAPI_KEY;

// Эмуляция перед подписью: принимает уже подписанный BOC, отдаёт публичный trace.
// 200 { ok:true, event } — эмуляция прошла; 200 { ok:false, rejected:true, error } —
// эмулятор отверг сообщение (это вердикт, а не сбой); 502 — tonapi недоступен.
app.post<{ Body: { boc: string; senderAddress?: string } }>('/emulate', async (request, reply) => {
  const response = await fetch(`${tonapiBase}/v2/events/emulate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tonapiKey ? { authorization: `Bearer ${tonapiKey}` } : {}),
    },
    body: JSON.stringify({ boc: request.body.boc }),
    signal: AbortSignal.timeout(toncenterTimeoutMs),
  });
  if (response.status >= 400 && response.status < 500) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    // Баланс и seqno отправителя глазами tonapi: клиент сравнит их с
    // toncenter, чтобы распознать отставший индексер (ложный отказ
    // эмулятора). Раньше проверяли только баланс — но балансы могут совпасть,
    // а seqno у tonapi отставать (после свежей исходящей tx это как раз
    // и приводило к EMULATION_REJECTED exit_code=133 «invalid_signature»
    // на следующую отправку).
    let emulatorBalance: string | undefined;
    let emulatorSeqno: number | undefined;
    if (request.body.senderAddress) {
      const sender = encodeURIComponent(request.body.senderAddress);
      await Promise.all([
        (async () => {
          try {
            const acc = await fetch(`${tonapiBase}/v2/accounts/${sender}`, {
              headers: { ...(tonapiKey ? { authorization: `Bearer ${tonapiKey}` } : {}) },
              signal: AbortSignal.timeout(toncenterTimeoutMs),
            });
            if (acc.ok) {
              const info = (await acc.json()) as { balance: number | string };
              emulatorBalance = String(info.balance);
            }
          } catch {
            /* baseline check only, недоступность не критична */
          }
        })(),
        (async () => {
          try {
            const s = await fetch(`${tonapiBase}/v2/wallet/${sender}/seqno`, {
              headers: { ...(tonapiKey ? { authorization: `Bearer ${tonapiKey}` } : {}) },
              signal: AbortSignal.timeout(toncenterTimeoutMs),
            });
            if (s.ok) {
              const info = (await s.json()) as { seqno: number };
              if (typeof info.seqno === 'number') emulatorSeqno = info.seqno;
            }
          } catch {
            /* baseline check only, недоступность не критична */
          }
        })(),
      ]);
    }
    return {
      ok: false,
      rejected: true,
      error: data.error ?? `tonapi ${response.status}`,
      ...(emulatorBalance !== undefined ? { emulatorBalance } : {}),
      ...(emulatorSeqno !== undefined ? { emulatorSeqno } : {}),
    };
  }
  if (!response.ok) {
    return reply.code(502).send({ ok: false, error: `tonapi HTTP ${response.status}` });
  }
  return { ok: true, event: await response.json() };
});

app.post<{ Body: { boc: string } }>('/send-boc', async (request) => {
  await toncenter('sendBoc', { boc: request.body.boc });
  return { sent: true };
});

await registerSocialRoutes(app);
await registerPushRoutes(app);

// Миграции идемпотентны и очень маленькие; на старте это ок.
// При отсутствии DATABASE_URL функция no-op — соц-эндпоинты вернут 503.
try {
  await runMigrations();
} catch (err) {
  app.log.error({ err }, 'db migration failed');
}

// Фоновый пуллер push-уведомлений (no-op при отсутствии DATABASE_URL/VAPID).
startPushPoller();

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
