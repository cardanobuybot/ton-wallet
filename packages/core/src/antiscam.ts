// Анти-скам проверки получателя перед подписью.
// Работают только на локальных данных (история транзакций) — без внешних сервисов.
import type { SimulationWarning } from './simulation.ts';
import type { TxCounterparty, TxHistoryItem } from './history.ts';

// Порог схожести friendly-форм: первые 2 символа — сетевой тег (всегда равны),
// поэтому префикс 6 = тег + 4 видимых символа; суффикс 4 — видимый «хвост» в UI.
// Вероятность случайного совпадения обоих концов ~64^-8 — ложных срабатываний
// практически не бывает, а вот vanity-адрес атакующего подделывает именно их.
export const POISONING_PREFIX_LEN = 6;
export const POISONING_SUFFIX_LEN = 4;

const sharedPrefixLen = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

const sharedSuffixLen = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
};

/**
 * Address poisoning: адрес получателя выглядит как знакомый контрагент
 * (совпадают видимые начало и конец friendly-формы), но это ДРУГОЙ адрес.
 * Возвращает контрагента, под которого маскируется получатель, либо null.
 * Обе friendly-формы должны быть отформатированы одинаково (одна сеть, non-bounceable).
 */
export function detectAddressPoisoning(
  recipient: TxCounterparty,
  counterparties: TxCounterparty[],
): TxCounterparty | null {
  for (const cp of counterparties) {
    if (cp.raw === recipient.raw) continue;
    if (
      sharedPrefixLen(cp.friendly, recipient.friendly) >= POISONING_PREFIX_LEN &&
      sharedSuffixLen(cp.friendly, recipient.friendly) >= POISONING_SUFFIX_LEN
    ) {
      return cp;
    }
  }
  return null;
}

export interface AnalyzeRecipientParams {
  recipient: TxCounterparty;
  history: TxHistoryItem[];
  /** Получатель помечен в локальной адресной книге — снимает first-time предупреждения */
  recipientLabeled?: boolean;
}

const short = (friendly: string): string => `${friendly.slice(0, 8)}…${friendly.slice(-6)}`;

/**
 * Правила анти-скама по локальной истории. ADDRESS_POISONING — danger
 * (блокирует отправку) и не снимается меткой адресной книги.
 */
export function analyzeRecipient(params: AnalyzeRecipientParams): SimulationWarning[] {
  const warnings: SimulationWarning[] = [];
  const counterparties = params.history
    .map((t) => t.counterparty)
    .filter((cp): cp is TxCounterparty => cp !== undefined);

  const lookalike = detectAddressPoisoning(params.recipient, counterparties);
  if (lookalike) {
    warnings.push({
      severity: 'danger',
      code: 'ADDRESS_POISONING',
      message:
        `Адрес получателя похож на ${short(lookalike.friendly)} из вашей истории, ` +
        `но это ДРУГОЙ адрес (${short(params.recipient.friendly)}). ` +
        'Похоже на атаку address poisoning: сверьте адрес ЦЕЛИКОМ, не по краям.',
    });
    return warnings;
  }

  if (!params.recipientLabeled) {
    const known = counterparties.some((cp) => cp.raw === params.recipient.raw);
    if (!known) {
      warnings.push({
        severity: 'info',
        code: 'NEW_RECIPIENT',
        message: 'Вы ещё не взаимодействовали с этим адресом.',
      });
    }
    if (!params.history.some((t) => t.direction === 'out' && t.counterparty)) {
      warnings.push({
        severity: 'info',
        code: 'FIRST_TRANSFER',
        message: 'Это ваш первый перевод с этого кошелька.',
      });
    }
  }

  return warnings;
}
