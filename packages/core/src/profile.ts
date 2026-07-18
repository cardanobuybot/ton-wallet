// Агрегация публичной активности адреса: суммы TON в/из + счётчики за окно времени.
// Используется на странице профиля /u/<address>. Джеттонные объёмы не суммируем —
// у каждого джеттона свои decimals, суммирование в разных единицах бессмысленно;
// показываем только счётчик джеттон-переводов.
import type { TxHistoryItem } from './history.ts';

export interface ProfileActivity {
  /** Число учтённых транзакций (в окне) */
  txCount: number;
  txIn: number;
  txOut: number;
  /** Сумма входящих TON (нанотоны), только для НЕ-джеттонных переводов */
  tonIn: bigint;
  /** Сумма исходящих TON (нанотоны), только для НЕ-джеттонных переводов */
  tonOut: bigint;
  /** Сколько распознанных джеттон-переводов в окне */
  jettonTxCount: number;
  /** Уникальные контрагенты (по raw-адресу) в окне */
  uniqueCounterparties: number;
  /** Unix-секунда самой свежей транзакции в окне (null если пусто) */
  latestUtime: number | null;
}

/**
 * Собирает публичную активность из уже распарсенной истории (parseTransactions).
 * `sinceUnix` — нижняя граница окна (включительно); undefined = учитываем все items.
 */
export function aggregateActivity(items: TxHistoryItem[], sinceUnix?: number): ProfileActivity {
  const acc: ProfileActivity = {
    txCount: 0,
    txIn: 0,
    txOut: 0,
    tonIn: 0n,
    tonOut: 0n,
    jettonTxCount: 0,
    uniqueCounterparties: 0,
    latestUtime: null,
  };
  const counterparties = new Set<string>();
  for (const t of items) {
    if (sinceUnix !== undefined && t.utime < sinceUnix) continue;
    acc.txCount++;
    if (t.direction === 'in') acc.txIn++;
    else acc.txOut++;
    if (t.jetton) {
      acc.jettonTxCount++;
    } else if (t.direction === 'in') {
      acc.tonIn += t.amount;
    } else {
      acc.tonOut += t.amount;
    }
    if (t.counterparty) counterparties.add(t.counterparty.raw);
    if (acc.latestUtime === null || t.utime > acc.latestUtime) acc.latestUtime = t.utime;
  }
  acc.uniqueCounterparties = counterparties.size;
  return acc;
}
