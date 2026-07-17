// Jetton transfer (TEP-74). Сообщение отправляется на СВОЙ jetton wallet,
// а не на адрес получателя; получатель указывается внутри тела.
import { beginCell, comment } from '@ton/core';
import type { Address, Cell } from '@ton/core';

export const JETTON_TRANSFER_OPCODE = 0x0f8a7ea5;
/** TON, прикладываемые к сообщению на jetton wallet (газ; излишек вернётся response-адресу) */
export const JETTON_TRANSFER_ATTACHED_TON = 50_000_000n; // 0.05 TON
/** forward_ton_amount: 1 нанотон — чтобы получателю пришло transfer_notification */
export const JETTON_FORWARD_TON = 1n;

export interface BuildJettonTransferBodyParams {
  /** Сумма в минимальных единицах джеттона (с учётом его decimals) */
  amount: bigint;
  /** Адрес получателя (владелец, не его jetton wallet) */
  to: Address;
  /** Куда вернуть излишек TON — свой кошелёк */
  responseTo: Address;
  comment?: string;
  queryId?: bigint;
}

export function buildJettonTransferBody(params: BuildJettonTransferBodyParams): Cell {
  return (
    beginCell()
      .storeUint(JETTON_TRANSFER_OPCODE, 32)
      .storeUint(params.queryId ?? 0n, 64)
      .storeCoins(params.amount)
      .storeAddress(params.to)
      .storeAddress(params.responseTo)
      .storeMaybeRef(null) // custom_payload
      .storeCoins(JETTON_FORWARD_TON)
      // forward_payload:(Either Cell ^Cell) — right-ветка (бит 1 + ref) или пустая left
      .storeMaybeRef(params.comment ? comment(params.comment) : null)
      .endCell()
  );
}
