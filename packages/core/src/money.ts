// ПРАВИЛО: деньги — только bigint в минимальных единицах. Float в денежном пути запрещён.
export { toNano, fromNano } from '@ton/core';

const TON_DECIMALS = 9;
const AMOUNT_RE = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Парсит сумму из пользовательского ввода в bigint минимальных единиц.
 * Принимает точку и запятую как разделитель, максимум `decimals` знаков после него.
 * Бросает на любом другом вводе (пустая строка, знак, экспонента, мусор).
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Некорректные decimals');
  }
  const match = AMOUNT_RE.exec(input.trim());
  if (!match) {
    throw new Error('Некорректная сумма');
  }
  const whole = match[1]!;
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`Максимум ${decimals} знаков после разделителя`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Форматирует минимальные единицы в строку без потери точности (без float). */
export function formatTokenAmount(units: bigint, decimals: number): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}

export const parseTonAmount = (input: string): bigint => parseTokenAmount(input, TON_DECIMALS);
export const formatTonAmount = (nano: bigint): string => formatTokenAmount(nano, TON_DECIMALS);
