// ПРАВИЛО: деньги — только bigint в нанотонах. Float в денежном пути запрещён.
export { toNano, fromNano } from '@ton/core';

const TON_DECIMALS = 9;
const AMOUNT_RE = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Парсит сумму в TON из пользовательского ввода в bigint нанотонов.
 * Принимает точку и запятую как разделитель, максимум 9 знаков после него.
 * Бросает на любом другом вводе (пустая строка, знак, экспонента, мусор).
 */
export function parseTonAmount(input: string): bigint {
  const match = AMOUNT_RE.exec(input.trim());
  if (!match) {
    throw new Error('Некорректная сумма');
  }
  const whole = match[1]!;
  const frac = match[2] ?? '';
  if (frac.length > TON_DECIMALS) {
    throw new Error(`Максимум ${TON_DECIMALS} знаков после разделителя`);
  }
  return BigInt(whole) * 10n ** BigInt(TON_DECIMALS) + BigInt(frac.padEnd(TON_DECIMALS, '0'));
}

/** Форматирует нанотоны в строку TON без потери точности (без float). */
export function formatTonAmount(nano: bigint): string {
  const sign = nano < 0n ? '-' : '';
  const abs = nano < 0n ? -nano : nano;
  const whole = abs / 10n ** BigInt(TON_DECIMALS);
  const frac = (abs % 10n ** BigInt(TON_DECIMALS)).toString().padStart(TON_DECIMALS, '0');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}
