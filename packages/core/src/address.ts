import { Address } from '@ton/core';
import type { Network } from './wallet.ts';

export interface ParsedRecipient {
  address: Address;
  /** raw-ввод не несёт сетевого флага; friendly — несёт и обязан совпасть с network */
  source: 'raw' | 'friendly';
}

/**
 * Принимает адрес получателя в raw (`0:<hex>`) или friendly форме.
 * Friendly-форма с флагом чужой сети отклоняется: mainnet-адрес (EQ/UQ)
 * на testnet почти наверняка ошибка пользователя, и наоборот.
 */
export function parseRecipientAddress(input: string, network: Network): ParsedRecipient {
  const trimmed = input.trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { address: Address.parseRaw(trimmed), source: 'raw' };
  }
  let parsed: ReturnType<typeof Address.parseFriendly>;
  try {
    parsed = Address.parseFriendly(trimmed);
  } catch {
    throw new Error('Некорректный адрес');
  }
  const expectTestOnly = network === 'testnet';
  if (parsed.isTestOnly !== expectTestOnly) {
    throw new Error(
      expectTestOnly
        ? 'Это mainnet-адрес, а кошелёк работает в testnet'
        : 'Это testnet-адрес, а кошелёк работает в mainnet',
    );
  }
  return { address: parsed.address, source: 'friendly' };
}

/** Friendly-форма адреса для показа пользователю (сетевой флаг из network). */
export function formatAddress(
  address: Address,
  network: Network,
  options?: { bounceable?: boolean },
): string {
  return address.toString({
    urlSafe: true,
    bounceable: options?.bounceable ?? false,
    testOnly: network === 'testnet',
  });
}
