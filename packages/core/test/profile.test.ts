import { describe, expect, it } from 'vitest';
import { aggregateActivity, type TxHistoryItem } from '../src/index.ts';

const CP_A = { raw: '0:aaaa', friendly: '0QAA...' };
const CP_B = { raw: '0:bbbb', friendly: '0QBB...' };

function ton(direction: 'in' | 'out', amount: bigint, utime: number, cp = CP_A): TxHistoryItem {
  return { direction, amount, fee: 0n, counterparty: cp, utime, lt: `${utime}`, hash: `h${utime}` };
}
function jetton(
  direction: 'in' | 'out',
  utime: number,
  cp = CP_A,
): TxHistoryItem {
  return {
    direction,
    amount: 0n,
    fee: 0n,
    counterparty: cp,
    jetton: { amount: 100n, jettonWallet: '0:jw' },
    utime,
    lt: `${utime}`,
    hash: `h${utime}`,
  };
}

describe('aggregateActivity', () => {
  it('пустой список → нули + latestUtime=null', () => {
    const a = aggregateActivity([]);
    expect(a.txCount).toBe(0);
    expect(a.tonIn).toBe(0n);
    expect(a.tonOut).toBe(0n);
    expect(a.jettonTxCount).toBe(0);
    expect(a.uniqueCounterparties).toBe(0);
    expect(a.latestUtime).toBeNull();
  });

  it('суммирует только TON, джеттоны отдельным счётчиком', () => {
    const a = aggregateActivity([
      ton('in', 5_000_000_000n, 100),
      ton('out', 1_000_000_000n, 200),
      jetton('out', 300),
      jetton('in', 400),
    ]);
    expect(a.txCount).toBe(4);
    expect(a.txIn).toBe(2);
    expect(a.txOut).toBe(2);
    expect(a.tonIn).toBe(5_000_000_000n);
    expect(a.tonOut).toBe(1_000_000_000n);
    expect(a.jettonTxCount).toBe(2);
    expect(a.latestUtime).toBe(400);
  });

  it('уникальные контрагенты по raw-адресу, не по friendly', () => {
    const a = aggregateActivity([
      ton('in', 1n, 10, CP_A),
      ton('out', 1n, 20, CP_A),
      ton('in', 1n, 30, CP_B),
    ]);
    expect(a.uniqueCounterparties).toBe(2);
  });

  it('отсекает по sinceUnix (нижняя граница включительно)', () => {
    const a = aggregateActivity(
      [ton('in', 5n, 100), ton('in', 7n, 200), ton('out', 3n, 300)],
      200,
    );
    expect(a.txCount).toBe(2);
    expect(a.tonIn).toBe(7n);
    expect(a.tonOut).toBe(3n);
    expect(a.latestUtime).toBe(300);
  });

  it('игнорирует counterparty=undefined в подсчёте уникальных', () => {
    const a = aggregateActivity([
      { direction: 'in', amount: 1n, fee: 0n, utime: 1, lt: '1', hash: 'h' },
    ]);
    expect(a.uniqueCounterparties).toBe(0);
    expect(a.txCount).toBe(1);
  });
});
