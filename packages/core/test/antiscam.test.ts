import { describe, expect, it } from 'vitest';
import {
  analyzeRecipient,
  applyWarnings,
  buildSimulationReport,
  detectAddressPoisoning,
  detectFakeToken,
  normalizeTokenSymbol,
  type TxCounterparty,
  type TxHistoryItem,
} from '../src/index.ts';

// Friendly-форма — 48 символов; собираем адреса с управляемыми краями
const mkFriendly = (prefix: string, middle: string, suffix: string): string =>
  prefix + middle.repeat(48 - prefix.length - suffix.length) + suffix;

const known: TxCounterparty = {
  raw: '0:' + '11'.repeat(32),
  friendly: mkFriendly('0QAb12', 'X', 'Tail'),
};
// Тот же видимый префикс и суффикс, но другой адрес — poisoning
const lookalike: TxCounterparty = {
  raw: '0:' + '22'.repeat(32),
  friendly: mkFriendly('0QAb12', 'Y', 'Tail'),
};
// Совпадает только префикс
const prefixOnly: TxCounterparty = {
  raw: '0:' + '33'.repeat(32),
  friendly: mkFriendly('0QAb12', 'Z', 'Diff'),
};

const tx = (cp: TxCounterparty | undefined, direction: 'in' | 'out'): TxHistoryItem => ({
  direction,
  ...(cp ? { counterparty: cp } : {}),
  amount: 1_000_000_000n,
  fee: 1n,
  utime: 1_752_600_000,
  lt: '1',
  hash: 'aGFzaA==',
});

describe('detectAddressPoisoning', () => {
  it('находит адрес, маскирующийся под знакомого контрагента', () => {
    expect(detectAddressPoisoning(lookalike, [known])).toEqual(known);
  });

  it('не считает сам знакомый адрес отравленным', () => {
    expect(detectAddressPoisoning(known, [known])).toBeNull();
  });

  it('совпадение только префикса — не poisoning', () => {
    expect(detectAddressPoisoning(prefixOnly, [known])).toBeNull();
  });
});

describe('analyzeRecipient', () => {
  it('poisoning → danger ADDRESS_POISONING, других предупреждений нет', () => {
    const warnings = analyzeRecipient({ recipient: lookalike, history: [tx(known, 'out')] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('ADDRESS_POISONING');
    expect(warnings[0]!.severity).toBe('danger');
  });

  it('пустая история → NEW_RECIPIENT (info) + FIRST_TRANSFER (info)', () => {
    const warnings = analyzeRecipient({ recipient: known, history: [] });
    expect(warnings.map((w) => w.code)).toEqual(['NEW_RECIPIENT', 'FIRST_TRANSFER']);
    // Тихие подсказки, не warn: шум мешает пользователю (решение владельца, спринт 6)
    expect(warnings.every((w) => w.severity === 'info')).toBe(true);
  });

  it('метка адресной книги снимает first-time предупреждения', () => {
    expect(
      analyzeRecipient({ recipient: known, history: [], recipientLabeled: true }),
    ).toHaveLength(0);
  });

  it('знакомый получатель при наличии исходящих — без предупреждений', () => {
    expect(
      analyzeRecipient({ recipient: known, history: [tx(known, 'out')] }),
    ).toHaveLength(0);
  });

  it('входящие есть, исходящих нет → NEW_RECIPIENT + FIRST_TRANSFER', () => {
    const codes = analyzeRecipient({
      recipient: prefixOnly,
      history: [tx(known, 'in')],
    }).map((w) => w.code);
    expect(codes).toEqual(['NEW_RECIPIENT', 'FIRST_TRANSFER']);
  });
});

describe('applyWarnings', () => {
  it('добавляет предупреждения и пересчитывает вердикт', () => {
    const report = buildSimulationReport({
      event: null,
      ownAddressRaw: known.raw,
      balance: 10_000_000_000n,
      enteredAmount: 1_000_000_000n,
      recipientDeployed: true,
      fallbackFee: 3_000_000n,
    });
    expect(report.verdict).toBe('warn'); // SIMULATION_UNAVAILABLE
    const merged = applyWarnings(report, [
      { severity: 'danger', code: 'ADDRESS_POISONING', message: 'test' },
    ]);
    expect(merged.verdict).toBe('danger');
    expect(merged.warnings[0]!.code).toBe('ADDRESS_POISONING');
    expect(applyWarnings(report, [])).toBe(report);
  });
});

describe('detectFakeToken', () => {
  const officialTestnetUsdt = '0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e';
  const fakeMaster = '0:501d1481576a4ea1ff9acf279c4e725dce76e9ca6c90622338060c23b47356a0';

  it('чужой мастер с символом USDT → danger FAKE_TOKEN', () => {
    const w = detectFakeToken({ symbol: 'USDT', masterRaw: fakeMaster, network: 'testnet' });
    expect(w?.code).toBe('FAKE_TOKEN');
    expect(w?.severity).toBe('danger');
  });

  it('официальный мастер → null', () => {
    expect(
      detectFakeToken({ symbol: 'USD₮', masterRaw: officialTestnetUsdt, network: 'testnet' }),
    ).toBeNull();
  });

  it('неизвестный символ → null', () => {
    expect(detectFakeToken({ symbol: 'GTT', masterRaw: fakeMaster, network: 'testnet' })).toBeNull();
  });

  it('кириллические двойники и типографика ловятся', () => {
    // 'УSDТ' — кириллические У и Т; 'usd₮' — строчные + знак тезера
    for (const symbol of ['УSDТ', 'usd₮', 'U S D T']) {
      expect(
        detectFakeToken({ symbol, masterRaw: fakeMaster, network: 'testnet' })?.code,
      ).toBe('FAKE_TOKEN');
    }
  });

  it('подделка по name при пустом symbol', () => {
    const w = detectFakeToken({ name: 'USDT', masterRaw: fakeMaster, network: 'testnet' });
    expect(w?.code).toBe('FAKE_TOKEN');
  });

  it('мастер сравнивается без учёта регистра', () => {
    expect(
      detectFakeToken({
        symbol: 'USDT',
        masterRaw: officialTestnetUsdt.toUpperCase().replace('0:', '0:'),
        network: 'testnet',
      }),
    ).toBeNull();
  });

  it('normalizeTokenSymbol канонизирует', () => {
    expect(normalizeTokenSymbol('usd₮')).toBe('USDT');
    expect(normalizeTokenSymbol('УSDТ')).toBe('USDT');
    expect(normalizeTokenSymbol('N0T')).toBe('NOT');
  });
});
