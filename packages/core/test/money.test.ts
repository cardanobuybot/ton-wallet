import { describe, expect, it } from 'vitest';
import { formatTonAmount, parseTonAmount } from '../src/index.ts';

describe('parseTonAmount', () => {
  it('парсит целые и дробные с точкой', () => {
    expect(parseTonAmount('1')).toBe(1_000_000_000n);
    expect(parseTonAmount('0.5')).toBe(500_000_000n);
    expect(parseTonAmount('1.000000001')).toBe(1_000_000_001n);
    expect(parseTonAmount('0.000000001')).toBe(1n);
  });

  it('принимает запятую как разделитель', () => {
    expect(parseTonAmount('2,5')).toBe(2_500_000_000n);
    expect(parseTonAmount(' 10,25 ')).toBe(10_250_000_000n);
  });

  it('режет больше 9 знаков после разделителя', () => {
    expect(() => parseTonAmount('1.0000000001')).toThrow();
  });

  it('режет мусор', () => {
    for (const bad of ['', ' ', 'abc', '1.2.3', '1,2,3', '-1', '+1', '1e9', '.5', '5.', '1 000']) {
      expect(() => parseTonAmount(bad), bad).toThrow();
    }
  });
});

describe('formatTonAmount', () => {
  it('форматирует без потери точности', () => {
    expect(formatTonAmount(1_000_000_000n)).toBe('1');
    expect(formatTonAmount(1_500_000_000n)).toBe('1.5');
    expect(formatTonAmount(1n)).toBe('0.000000001');
    expect(formatTonAmount(0n)).toBe('0');
    expect(formatTonAmount(-2_500_000_000n)).toBe('-2.5');
  });

  it('roundtrip parse → format', () => {
    for (const s of ['1', '0.5', '123.456789012', '0.000000001']) {
      expect(formatTonAmount(parseTonAmount(s))).toBe(s.replace(',', '.'));
    }
  });
});
