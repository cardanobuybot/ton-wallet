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

// ── Fake-token детект ────────────────────────────────────────────────────────
// Джеттон с символом известного токена, но чужим мастер-контрактом — подделка.
// Реестр официальных мастеров (raw, lowercase); адреса верифицированы on-chain
// через toncenter v3 2026-07-17.

export interface KnownJetton {
  symbol: string;
  masterRaw: string;
}

export const KNOWN_JETTONS: Record<'mainnet' | 'testnet', readonly KnownJetton[]> = {
  mainnet: [
    {
      symbol: 'USDT',
      masterRaw: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
    },
    {
      symbol: 'NOT',
      masterRaw: '0:2f956143c461769579baef2e32cc2d7bc18283f40d20bb03e432cd603ac33ffc',
    },
  ],
  testnet: [
    {
      symbol: 'USDT',
      masterRaw: '0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e',
    },
  ],
};

// Кириллические и типографские двойники латиницы, которыми маскируют символ
const LOOKALIKES: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P',
  С: 'C', Т: 'T', У: 'U', Х: 'X', '₮': 'T', '0': 'O',
};

/** 'USD₮', 'usdt', 'УSDТ' → 'USDT'-подобная каноническая форма */
export const normalizeTokenSymbol = (s: string): string =>
  [...s.toUpperCase()].map((ch) => LOOKALIKES[ch] ?? ch).join('').replace(/[^A-Z]/g, '');

export interface DetectFakeTokenParams {
  symbol?: string | undefined;
  name?: string | undefined;
  masterRaw: string;
  network: 'mainnet' | 'testnet';
}

/**
 * Символ (или имя) совпадает с известным токеном, а мастер — другой → danger.
 * Официальный мастер или неизвестный символ → null.
 */
export function detectFakeToken(params: DetectFakeTokenParams): SimulationWarning | null {
  const master = params.masterRaw.toLowerCase();
  const candidates = [params.symbol, params.name].filter((v): v is string => Boolean(v));
  for (const known of KNOWN_JETTONS[params.network]) {
    const impersonates = candidates.some((c) => normalizeTokenSymbol(c) === known.symbol);
    if (impersonates && master !== known.masterRaw) {
      return {
        severity: 'danger',
        code: 'FAKE_TOKEN',
        message:
          `Токен выдаёт себя за ${known.symbol}, но его контракт не совпадает ` +
          'с официальным. Это подделка — не отправляйте и не принимайте её всерьёз.',
      };
    }
  }
  return null;
}
