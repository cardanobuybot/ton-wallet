import {
  Address,
  beginCell,
  Cell,
  comment,
  external,
  internal,
  loadStateInit,
  SendMode,
  storeMessage,
} from '@ton/core';
import type { MessageRelaxed } from '@ton/core';
import type { KeyPair } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';
import { getWalletContract } from './wallet.ts';
import type { Network, WalletVersion } from './wallet.ts';

export const TRANSFER_TTL_SECONDS = 300;

/**
 * ПРАВИЛО BOUNCE: перевод на кошелёк — bounce=false. Если получатель
 * не задеплоен, bounce принудительно false независимо от запрошенного,
 * иначе bounced-сообщение вернёт TON отправителю и получатель ничего
 * не получит.
 */
export function resolveBounce(requestedBounce: boolean, recipientDeployed: boolean): boolean {
  if (!recipientDeployed) {
    return false;
  }
  return requestedBounce;
}

export interface CreateTransferParams {
  keyPair: KeyPair;
  version: WalletVersion;
  network: Network;
  /** Текущий seqno кошелька; 0 — кошелёк не задеплоен, приложим stateInit */
  seqno: number;
  to: Address;
  /** Нанотоны (bigint). Float в денежном пути запрещён. */
  amount: bigint;
  bounce: boolean;
  comment?: string;
  /** Произвольное тело внутреннего сообщения (напр. jetton transfer). Взаимоисключимо с comment. */
  body?: Cell;
  /** Для тестов: «сейчас» в unix-секундах */
  now?: number;
}

export interface SignedTransfer {
  /** Внешнее сообщение, готовое к POST /send-boc (base64 BOC) */
  bocBase64: string;
  /** Тело external отдельно — для toncenter estimateFee */
  bodyBocBase64: string;
  /** stateInit (только при деплое, seqno=0) — для estimateFee */
  initCodeBocBase64?: string;
  initDataBocBase64?: string;
  /** unix-время истечения */
  validUntil: number;
}

/**
 * Собирает и подписывает external-сообщение перевода для W5.
 *
 * Повторная отправка этого BOC безопасна: контракт принимает сообщение
 * только с текущим seqno (после исполнения seqno увеличивается, повтор
 * отбрасывается), а после validUntil (= now + 5 минут) сообщение
 * отбрасывается по TTL — «зависший» BOC не может исполниться позже.
 */
export function createTransfer(params: CreateTransferParams): SignedTransfer {
  const wallet = getWalletContract(params.keyPair, {
    version: params.version,
    network: params.network,
  });
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const validUntil = now + TRANSFER_TTL_SECONDS;

  const transferArgs = {
    seqno: params.seqno,
    secretKey: params.keyPair.secretKey,
    timeout: validUntil,
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: params.to,
        value: params.amount,
        bounce: params.bounce,
        body: params.body ?? (params.comment ? comment(params.comment) : undefined),
      }),
    ] as MessageRelaxed[],
  };
  // Разные классы контрактов — разные generic-сигнатуры createTransfer,
  // union напрямую не вызывается; форма signed-аргументов у всех одна.
  const body: Cell =
    wallet instanceof WalletContractV5R1
      ? wallet.createTransfer(transferArgs)
      : wallet.createTransfer(transferArgs);

  const deploy = params.seqno === 0;
  const message = external({
    to: wallet.address,
    init: deploy ? wallet.init : undefined,
    body,
  });
  const bocBase64 = beginCell().store(storeMessage(message)).endCell().toBoc().toString('base64');
  return {
    bocBase64,
    bodyBocBase64: body.toBoc().toString('base64'),
    ...(deploy
      ? {
          initCodeBocBase64: wallet.init.code.toBoc().toString('base64'),
          initDataBocBase64: wallet.init.data.toBoc().toString('base64'),
        }
      : {}),
    validUntil,
  };
}

// ---------- произвольные сообщения (TON Connect sendTransaction) ----------

export interface RawTransferMessage {
  /** raw или friendly; у friendly учитывается bounce-флаг */
  address: string;
  /** нанотоны */
  amount: bigint;
  /** base64 BOC тела сообщения */
  payload?: string;
  /** base64 BOC stateInit получателя (деплой) */
  stateInit?: string;
}

export interface CreateRawTransferParams {
  keyPair: KeyPair;
  version: WalletVersion;
  network: Network;
  seqno: number;
  /** 1–4 сообщения из sendTransaction */
  messages: RawTransferMessage[];
  /** valid_until из запроса dApp; отсутствует → now + TTL */
  validUntil?: number;
  /** Для тестов: «сейчас» в unix-секундах */
  now?: number;
}

/**
 * Подписывает external с произвольными внутренними сообщениями dApp.
 * Bounce: у friendly-адреса — его флаг; raw и деплой (stateInit) — false,
 * чтобы TON не «отскочил» от незадеплоенного получателя.
 */
export function createRawTransfer(params: CreateRawTransferParams): SignedTransfer {
  if (params.messages.length < 1 || params.messages.length > 4) {
    throw new Error(`Ожидалось 1–4 сообщения, получено ${params.messages.length}`);
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (params.validUntil !== undefined && params.validUntil <= now) {
    throw new Error('Запрос dApp просрочен (valid_until в прошлом)');
  }
  const validUntil = Math.min(params.validUntil ?? now + TRANSFER_TTL_SECONDS, now + TRANSFER_TTL_SECONDS);

  const internals = params.messages.map((m) => {
    const friendly = Address.isFriendly(m.address);
    const to = friendly ? Address.parseFriendly(m.address).address : Address.parse(m.address);
    const bounce = friendly && m.stateInit === undefined
      ? Address.parseFriendly(m.address).isBounceable
      : false;
    return internal({
      to,
      value: m.amount,
      bounce,
      body: m.payload !== undefined ? Cell.fromBase64(m.payload) : undefined,
      init:
        m.stateInit !== undefined
          ? loadStateInit(Cell.fromBase64(m.stateInit).beginParse())
          : undefined,
    });
  }) as MessageRelaxed[];

  const wallet = getWalletContract(params.keyPair, {
    version: params.version,
    network: params.network,
  });
  const transferArgs = {
    seqno: params.seqno,
    secretKey: params.keyPair.secretKey,
    timeout: validUntil,
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    messages: internals,
  };
  const body: Cell =
    wallet instanceof WalletContractV5R1
      ? wallet.createTransfer(transferArgs)
      : wallet.createTransfer(transferArgs);

  const deploy = params.seqno === 0;
  const message = external({
    to: wallet.address,
    init: deploy ? wallet.init : undefined,
    body,
  });
  return {
    bocBase64: beginCell().store(storeMessage(message)).endCell().toBoc().toString('base64'),
    bodyBocBase64: body.toBoc().toString('base64'),
    ...(deploy
      ? {
          initCodeBocBase64: wallet.init.code.toBoc().toString('base64'),
          initDataBocBase64: wallet.init.data.toBoc().toString('base64'),
        }
      : {}),
    validUntil,
  };
}
