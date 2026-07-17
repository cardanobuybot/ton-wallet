// История транзакций: парсер ответа toncenter getTransactions.
// Осознанно toncenter, не tonapi: индексер tonapi на testnet отстаёт на дни.
import { Address, Cell } from '@ton/core';
import { formatAddress } from './address.ts';
import type { Network } from './wallet.ts';

export interface TxCounterparty {
  raw: string;
  friendly: string;
}

/** Распознанный TEP-74 перевод джеттона внутри транзакции */
export interface TxJettonInfo {
  /** Количество в минимальных единицах джеттона (decimals неизвестны на этом уровне) */
  amount: bigint;
  /** raw-адрес джеттон-кошелька (сопоставляется с балансами для символа/decimals) */
  jettonWallet: string;
}

export interface TxHistoryItem {
  direction: 'in' | 'out';
  /** Отсутствует у внешних сообщений без исходящих переводов (напр. чистый деплой) */
  counterparty?: TxCounterparty;
  /** Сумма перевода, нанотоны (всегда >= 0; для out — сумма всех исходящих) */
  amount: bigint;
  /** Комиссия транзакции, нанотоны */
  fee: bigint;
  /** Есть только у распознанных джеттон-переводов; counterparty тогда — человек, не контракт */
  jetton?: TxJettonInfo;
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
  msg_data?: { '@type': string; body?: string };
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

// TEP-74 опкоды: transfer (исходящий на свой джеттон-кошелёк) и
// transfer_notification (входящий от своего джеттон-кошелька)
const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const JETTON_NOTIFICATION_OP = 0x7362d09c;

interface ParsedJettonMsg {
  amount: bigint;
  /** Человеческий контрагент: получатель (transfer) либо отправитель (notification) */
  counterpartyAddress: Address;
  comment?: string;
}

/** Комментарий из forward_payload (Either Cell): op 0 + текст */
function readForwardComment(s: ReturnType<Cell['beginParse']>): string | undefined {
  const payload = s.loadBit() ? s.loadRef().beginParse() : s;
  if (payload.remainingBits < 32 || payload.loadUint(32) !== 0) return undefined;
  const text = payload.loadStringTail();
  return text.length > 0 ? text : undefined;
}

/** Разбирает тело сообщения как TEP-74; не TEP-74 или битое тело → null */
function parseJettonBody(msg: ToncenterMessage | undefined): ParsedJettonMsg | null {
  const body = msg?.msg_data?.['@type'] === 'msg.dataRaw' ? msg.msg_data.body : undefined;
  if (!body) return null;
  try {
    const s = Cell.fromBase64(body).beginParse();
    if (s.remainingBits < 32) return null;
    const op = s.loadUint(32);
    if (op !== JETTON_TRANSFER_OP && op !== JETTON_NOTIFICATION_OP) return null;
    s.loadUintBig(64); // query_id
    const amount = s.loadCoins();
    const counterpartyAddress = s.loadAddress();
    if (op === JETTON_TRANSFER_OP) {
      s.loadMaybeAddress(); // response_destination
      s.loadMaybeRef(); // custom_payload
      s.loadCoins(); // forward_ton_amount
    }
    const comment = readForwardComment(s);
    return { amount, counterpartyAddress, ...(comment !== undefined ? { comment } : {}) };
  } catch {
    return null;
  }
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
      const first = t.out_msgs[0]!;
      const jettonMsg = parseJettonBody(first);
      // Джеттон-перевод: контрагент — человек из тела, а не свой jetton wallet
      const cp = jettonMsg
        ? counterparty(jettonMsg.counterpartyAddress.toRawString(), network)
        : counterparty(first.destination, network);
      const comment = jettonMsg?.comment ?? textComment(first);
      return {
        direction: 'out' as const,
        amount,
        ...(cp ? { counterparty: cp } : {}),
        ...(jettonMsg
          ? {
              jetton: {
                amount: jettonMsg.amount,
                jettonWallet: Address.parse(first.destination).toRawString(),
              },
            }
          : {}),
        ...(comment !== undefined ? { comment } : {}),
        ...base,
      };
    }
    const jettonMsg = parseJettonBody(t.in_msg);
    const cp = jettonMsg
      ? counterparty(jettonMsg.counterpartyAddress.toRawString(), network)
      : counterparty(t.in_msg?.source ?? '', network);
    const comment = jettonMsg?.comment ?? textComment(t.in_msg);
    return {
      direction: cp ? ('in' as const) : ('out' as const),
      amount: cp ? toBigInt(t.in_msg?.value) : 0n,
      ...(cp ? { counterparty: cp } : {}),
      ...(jettonMsg
        ? {
            jetton: {
              amount: jettonMsg.amount,
              jettonWallet: Address.parse(t.in_msg!.source).toRawString(),
            },
          }
        : {}),
      ...(comment !== undefined ? { comment } : {}),
      ...base,
    };
  });
}
