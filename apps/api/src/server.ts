// ПРАВИЛО ПРОЕКТА: этот сервис никогда не касается приватных ключей,
// мнемоник и подписи. Только публичные данные и уже подписанный BOC.
import Fastify from 'fastify';

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
    // Баланс отправителя глазами tonapi: клиент сравнит его с балансом по
    // toncenter, чтобы распознать отставший индексер (ложный отказ эмулятора).
    let emulatorBalance: string | undefined;
    if (request.body.senderAddress) {
      try {
        const acc = await fetch(
          `${tonapiBase}/v2/accounts/${encodeURIComponent(request.body.senderAddress)}`,
          {
            headers: { ...(tonapiKey ? { authorization: `Bearer ${tonapiKey}` } : {}) },
            signal: AbortSignal.timeout(toncenterTimeoutMs),
          },
        );
        if (acc.ok) {
          const info = (await acc.json()) as { balance: number | string };
          emulatorBalance = String(info.balance);
        }
      } catch {
        // недоступно — просто не прикладываем баланс
      }
    }
    return {
      ok: false,
      rejected: true,
      error: data.error ?? `tonapi ${response.status}`,
      ...(emulatorBalance !== undefined ? { emulatorBalance } : {}),
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

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
