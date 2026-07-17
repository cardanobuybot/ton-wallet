// История транзакций: парсер ответа toncenter getTransactions.
// Осознанно toncenter, не tonapi: индексер tonapi на testnet отстаёт на дни.
import { Address } from '@ton/core';
import { formatAddress } from './address.ts';
import type { Network } from './wallet.ts';

export interface TxCounterparty {
  raw: string;
  friendly: string;
}

export interface TxHistoryItem {
  direction: 'in' | 'out';
  /** Отсутствует у внешних сообщений без исходящих переводов (напр. чистый деплой) */
  counterparty?: TxCounterparty;
  /** Сумма перевода, нанотоны (всегда >= 0; для out — сумма всех исходящих) */
  amount: bigint;
  /** Комиссия транзакции, нанотоны */
  fee: bigint;
  comment?: string;
  utime: number;
  lt: string;
  hash: string;
}

interface ToncenterMessage {
  source: string;
  destination: string;
  value: number | string;
  message?: string;
  msg_data?: { '@type': string };
}

interface ToncenterTx {
  utime: number;
  fee: number | string;
  transaction_id: { lt: string; hash: string };
  in_msg?: ToncenterMessage;
  out_msgs: ToncenterMessage[];
}

const toBigInt = (v: number | string | undefined): bigint => BigInt(String(v ?? 0));

/** Комментарий — только явный текст (msg.dataText); raw-тела сообщений не показываем. */
function textComment(msg: ToncenterMessage | undefined): string | undefined {
  return msg?.msg_data?.['@type'] === 'msg.dataText' && msg.message ? msg.message : undefined;
}

function counterparty(addr: string, network: Network): TxCounterparty | undefined {
  if (!addr) return undefined;
  // toncenter отдаёт friendly с mainnet-флагом даже на testnet — парсим без проверки флага
  const parsed = Address.parse(addr);
  return { raw: parsed.toRawString(), friendly: formatAddress(parsed, network) };
}

export function parseTransactions(result: unknown, network: Network): TxHistoryItem[] {
  const txs = result as ToncenterTx[];
  return txs.map((t) => {
    const base = {
      fee: toBigInt(t.fee),
      utime: t.utime,
      lt: t.transaction_id.lt,
      hash: t.transaction_id.hash,
    };
    if (t.out_msgs.length > 0) {
      const amount = t.out_msgs.reduce((sum, m) => sum + toBigInt(m.value), 0n);
      const cp = counterparty(t.out_msgs[0]!.destination, network);
      const comment = textComment(t.out_msgs[0]);
      return {
        direction: 'out' as const,
        amount,
        ...(cp ? { counterparty: cp } : {}),
        ...(comment !== undefined ? { comment } : {}),
        ...base,
      };
    }
    const cp = counterparty(t.in_msg?.source ?? '', network);
    const comment = textComment(t.in_msg);
    return {
      direction: cp ? ('in' as const) : ('out' as const),
      amount: cp ? toBigInt(t.in_msg?.value) : 0n,
      ...(cp ? { counterparty: cp } : {}),
      ...(comment !== undefined ? { comment } : {}),
      ...base,
    };
  });
}
