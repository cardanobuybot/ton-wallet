// NFT transfer (TEP-62). Сообщение отправляется на адрес самого NFT-item
// контракта (не коллекции). NFT-item верифицирует, что отправитель — текущий
// владелец, и записывает newOwner в своё состояние.
import { beginCell, comment } from '@ton/core';
import type { Address, Cell } from '@ton/core';

export const NFT_TRANSFER_OPCODE = 0x5fcc3d14;
/**
 * TON, прикладываемые к сообщению на NFT-item (газ на выполнение + forward).
 * Стандартный размер по практике tonkeeper/mytonwallet — 0.05 TON. Излишек
 * возвращается на responseTo.
 */
export const NFT_TRANSFER_ATTACHED_TON = 50_000_000n; // 0.05 TON
/** forward_ton_amount: 1 нанотон — чтобы newOwner получил ownership_assigned. */
export const NFT_FORWARD_TON = 1n;

export interface BuildNftTransferBodyParams {
  /** Новый владелец NFT (обычный кошелёк, а не item-контракт) */
  newOwner: Address;
  /** Куда вернуть излишек TON — свой кошелёк */
  responseTo: Address;
  comment?: string;
  queryId?: bigint;
}

export function buildNftTransferBody(params: BuildNftTransferBodyParams): Cell {
  return beginCell()
    .storeUint(NFT_TRANSFER_OPCODE, 32)
    .storeUint(params.queryId ?? 0n, 64)
    .storeAddress(params.newOwner)
    .storeAddress(params.responseTo)
    .storeMaybeRef(null) // custom_payload
    .storeCoins(NFT_FORWARD_TON)
    // forward_payload:(Either Cell ^Cell) — right-ветка (ref) или пустая
    .storeMaybeRef(params.comment ? comment(params.comment) : null)
    .endCell();
}
