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
