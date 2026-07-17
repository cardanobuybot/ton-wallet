import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSimulationReport } from '../src/index.ts';
import { EXPECTED_TESTNET } from './fixtures.ts';

const okEvent = JSON.parse(
  readFileSync(new URL('./fixtures/emulate-ok.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const rejected = JSON.parse(
  readFileSync(new URL('./fixtures/emulate-rejected.json', import.meta.url), 'utf8'),
) as { error: string };

// Отправитель из ok-фикстуры (v4-кошелёк деплойера, публичный testnet-адрес)
const OWN_RAW = '0:3fe8117b619334c4863029278a44e35dce037d45634337c0ea92aee9143b60e6';

const base = {
  event: okEvent,
  ownAddressRaw: OWN_RAW,
  balance: 7_983_508_196n,
  enteredAmount: 500_000_000n,
  recipientDeployed: true,
};

describe('buildSimulationReport: ok-путь', () => {
  it('парсит value_flow и actions из реального ответа tonapi', () => {
    const r = buildSimulationReport(base);
    expect(r.emulated).toBe(true);
    expect(r.verdict).toBe('ok');
    expect(r.warnings).toHaveLength(0);
    expect(r.balanceChange).toBe(-500_526_285n);
    expect(r.fees).toBe(526_285n);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe('TonTransfer');
    expect(r.actions[0]!.amount).toBe(500_000_000n);
    expect(r.actions[0]!.recipientRaw).toBe(EXPECTED_TESTNET.raw);
  });
});

describe('правила предупреждений', () => {
  it('отказ эмулятора → danger EMULATION_REJECTED', () => {
    const r = buildSimulationReport({ ...base, event: null, rejectionError: rejected.error });
    expect(r.emulated).toBe(false);
    expect(r.verdict).toBe('danger');
    expect(r.warnings.map((w) => w.code)).toContain('EMULATION_REJECTED');
  });

  it('эмуляция недоступна → warn SIMULATION_UNAVAILABLE, отправка не блокируется', () => {
    const r = buildSimulationReport({ ...base, event: null, fallbackFee: 1_000_000n });
    expect(r.verdict).toBe('warn');
    expect(r.warnings.map((w) => w.code)).toContain('SIMULATION_UNAVAILABLE');
    expect(r.fees).toBe(1_000_000n);
    expect(r.balanceChange).toBe(-501_000_000n);
  });

  it('> 50% баланса → warn LARGE_TRANSFER', () => {
    const r = buildSimulationReport({ ...base, enteredAmount: 5_000_000_000n });
    expect(r.warnings.map((w) => w.code)).toContain('LARGE_TRANSFER');
    expect(r.verdict).toBe('warn');
  });

  it('получатель-контракт → warn CONTRACT_RECIPIENT', () => {
    const mutated = structuredClone(okEvent) as {
      actions: Array<{ TonTransfer: { recipient: { is_wallet: boolean } } }>;
    };
    mutated.actions[0]!.TonTransfer.recipient.is_wallet = false;
    const r = buildSimulationReport({ ...base, event: mutated });
    expect(r.warnings.map((w) => w.code)).toContain('CONTRACT_RECIPIENT');
    expect(r.verdict).toBe('warn');
  });

  it('скам-флаг → danger SCAM_FLAG', () => {
    const mutated = structuredClone(okEvent) as {
      actions: Array<{ TonTransfer: { recipient: { is_scam: boolean } } }>;
    };
    mutated.actions[0]!.TonTransfer.recipient.is_scam = true;
    const r = buildSimulationReport({ ...base, event: mutated });
    expect(r.verdict).toBe('danger');
    expect(r.warnings.map((w) => w.code)).toContain('SCAM_FLAG');
  });

  it('упавшее действие → danger ACTION_FAILED', () => {
    const mutated = structuredClone(okEvent) as { actions: Array<{ status: string }> };
    mutated.actions[0]!.status = 'failed';
    const r = buildSimulationReport({ ...base, event: mutated });
    expect(r.verdict).toBe('danger');
    expect(r.warnings.map((w) => w.code)).toContain('ACTION_FAILED');
  });

  it('расход заметно больше введённого → warn SPEND_EXCEEDS_AMOUNT', () => {
    const r = buildSimulationReport({ ...base, enteredAmount: 100_000_000n });
    expect(r.warnings.map((w) => w.code)).toContain('SPEND_EXCEEDS_AMOUNT');
  });

  it('незадеплоенный получатель → info, вердикт остаётся ok', () => {
    const r = buildSimulationReport({ ...base, recipientDeployed: false });
    expect(r.warnings.map((w) => w.code)).toContain('RECIPIENT_NOT_DEPLOYED');
    expect(r.verdict).toBe('ok');
  });
});
