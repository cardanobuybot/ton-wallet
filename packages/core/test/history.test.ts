import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTransactions } from '../src/index.ts';

// Реальный ответ toncenter getTransactions для testnet-кошелька владельца:
// [0] исходящий перевод 1 TON (external + out_msg), [1] входящие 2 TON с крана.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/transactions.json', import.meta.url), 'utf8'),
) as unknown[];

const OWN_RAW = '0:6476c1cfaab8f4462788bf2e4c86a7844215bcce2bd907835899c43ef18f105a';
const RECIPIENT_RAW = '0:3fe8117b619334c4863029278a44e35dce037d45634337c0ea92aee9143b60e6';

describe('parseTransactions', () => {
  const items = parseTransactions(fixture, 'testnet');

  it('парсит исходящий перевод: сумма, получатель, комиссия, метаданные', () => {
    const out = items[0]!;
    expect(out.direction).toBe('out');
    expect(out.amount).toBe(1_000_000_000n);
    expect(out.fee).toBe(980_033n);
    expect(out.counterparty?.raw).toBe(RECIPIENT_RAW);
    // friendly обязан нести testnet-флаг (kQ/0Q), а не EQ из ответа toncenter
    expect(out.counterparty?.friendly.startsWith('0Q')).toBe(true);
    expect(out.comment).toBeUndefined();
    expect(out.lt).toBe('83670432000001');
    expect(out.hash).toBe('2TerbfymisDJWcmz1M6igxF0V+eFfyjGbsUdo4KWuxM=');
    expect(out.utime).toBe(1784273998);
  });

  it('парсит входящий перевод с текстовым комментарием', () => {
    const inc = items[1]!;
    expect(inc.direction).toBe('in');
    expect(inc.amount).toBe(2_000_000_000n);
    expect(inc.comment).toBe('https://t.me/testgiver_ton_bot');
    expect(inc.counterparty?.raw).not.toBe(OWN_RAW);
  });

  it('raw-тело сообщения не выдаётся за комментарий', () => {
    // У исходящей [0] in_msg внешний с msg.dataRaw (подписанное тело) — не комментарий
    expect(items[0]!.comment).toBeUndefined();
  });

  it('external без исходящих (чистый деплой) → out без counterparty, сумма 0', () => {
    const mutated = structuredClone(fixture) as Array<{ out_msgs: unknown[] }>;
    mutated[0]!.out_msgs = [];
    const r = parseTransactions(mutated, 'testnet');
    expect(r[0]!.direction).toBe('out');
    expect(r[0]!.amount).toBe(0n);
    expect(r[0]!.counterparty).toBeUndefined();
  });
});

// Реальные TEP-74 транзакции GTT (testnet, 2026-07-17): исходящий transfer
// на свой jetton wallet, входящий transfer_notification, входящий excesses.
const JETTON_OUT_TX = {
  utime: 1784325984,
  fee: '618099',
  transaction_id: { lt: '83800925000001', hash: 'sZRnvgFBjXonobtllZvUv3FGb83a14PZ3DuSAq2ZJm0=' },
  in_msg: {
    source: '',
    destination: 'EQA-j_8YN2Q84WswldYVUeIcYAzeNie-dWxHmik0HQsY3qjo',
    value: '0',
    msg_data: { '@type': 'msg.dataRaw' },
  },
  out_msgs: [
    {
      source: 'EQA-j_8YN2Q84WswldYVUeIcYAzeNie-dWxHmik0HQsY3qjo',
      destination: 'EQANfves9Hc0S2wLyNPgwUr8ziCiOG3hAoqv16PJDIf3vvcC',
      value: '50000000',
      msg_data: {
        '@type': 'msg.dataRaw',
        body: 'te6cckEBAQEAWAAArA+KfqUAAAAAAAAAAFAlQL5ACAArFWkwEbPe2fjo1ejeA/49L6SAHOY7ey+TIdnOfH/NVwAPo//GDdkPOFrMJXWFVHiHGAM3jYnvnVsR5opNB0LGN4ICw8n4oA==',
      },
    },
  ],
};

const JETTON_NOTIFICATION_TX = {
  utime: 1784325988,
  fee: '0',
  transaction_id: { lt: '83800933000001', hash: 'pnsleJ0n94S9knpItk2p7CySSLwO6Dsl4D2viheZUUA=' },
  in_msg: {
    source: 'EQDjICdBwGwhJ9kxJIBpp1s8rXl22w_-4jRN22WmMex2W633',
    destination: 'EQAVirSYCNnvbPx0avRvAf8el9JADnMdvZfJkOznPj_mqxbW',
    value: '1',
    msg_data: {
      '@type': 'msg.dataRaw',
      body: 'te6cckEBAQEANQAAZnNi0JwAAAAAAAAAAFAlQL5ACAB9H/4wbsh5wtZhK6wqo8Q4wBm8bE986tiPNFJoOhYxvCS4Zgk=',
    },
  },
  out_msgs: [],
};

const EXCESSES_TX = {
  utime: 1784325988,
  fee: '51869',
  transaction_id: { lt: '83800933000001', hash: '65DaeXIrWpaJ+MVrSqINuaXEZC51Hg/xLQ1TfddO3Jg=' },
  in_msg: {
    source: 'EQDjICdBwGwhJ9kxJIBpp1s8rXl22w_-4jRN22WmMex2W633',
    destination: 'EQA-j_8YN2Q84WswldYVUeIcYAzeNie-dWxHmik0HQsY3qjo',
    value: '27993058',
    msg_data: { '@type': 'msg.dataRaw', body: 'te6cckEBAQEADgAAGNUydtsAAAAAAAAAAPfBmNw=' },
  },
  out_msgs: [],
};

describe('parseTransactions: TEP-74 джеттоны', () => {
  it('исходящий jetton transfer: количество, человеческий получатель, jetton wallet', () => {
    const [item] = parseTransactions([JETTON_OUT_TX], 'testnet');
    expect(item!.direction).toBe('out');
    expect(item!.jetton).toEqual({
      amount: 10_000_000_000n, // 10 GTT
      jettonWallet: '0:0d7ef7acf477344b6c0bc8d3e0c14afcce20a2386de1028aafd7a3c90c87f7be',
    });
    // counterparty — человек (v4r2-адрес), а не собственный jetton wallet
    expect(item!.counterparty?.raw).toBe(
      '0:158ab49808d9ef6cfc746af46f01ff1e97d2400e731dbd97c990ece73e3fe6ab',
    );
    expect(item!.counterparty?.friendly.startsWith('0Q')).toBe(true);
    expect(item!.amount).toBe(50_000_000n); // прикреплённый TON-газ
  });

  it('входящий transfer_notification: количество и человеческий отправитель', () => {
    const [item] = parseTransactions([JETTON_NOTIFICATION_TX], 'testnet');
    expect(item!.direction).toBe('in');
    expect(item!.jetton?.amount).toBe(10_000_000_000n);
    expect(item!.jetton?.jettonWallet).toBe(
      '0:e3202741c06c2127d931248069a75b3cad7976db0ffee2344ddb65a631ec765b',
    );
    // отправитель — владелец-человек (наш W5), не джеттон-кошелёк
    expect(item!.counterparty?.raw).toBe(
      '0:3e8fff1837643ce16b3095d61551e21c600cde3627be756c479a29341d0b18de',
    );
  });

  it('excesses не считается джеттон-переводом', () => {
    const [item] = parseTransactions([EXCESSES_TX], 'testnet');
    expect(item!.jetton).toBeUndefined();
    expect(item!.direction).toBe('in');
  });
});
