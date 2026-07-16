import type { Address } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import type { KeyPair } from '@ton/crypto';

export type WalletVersion = 'v5r1';
export type Network = 'testnet' | 'mainnet';

const NETWORK_GLOBAL_ID: Record<Network, number> = {
  mainnet: -239,
  testnet: -3,
};

export interface GetWalletAddressOptions {
  version: WalletVersion;
  network: Network;
}

export interface WalletAddress {
  /** Raw-форма: `0:<hex>` */
  raw: string;
  /** User-friendly, bounceable (EQ… / kQ…), url-safe */
  bounceable: string;
  /** User-friendly, non-bounceable (UQ… / 0Q…), url-safe */
  nonBounceable: string;
}

type AddressBuilder = (publicKey: Buffer, network: Network) => Address;

/**
 * Registry версий контрактов: новые кошельки — только v5r1,
 * но импорт v4r2/v3r2 добавится сюда же без изменения API.
 */
const ADDRESS_BUILDERS: Record<WalletVersion, AddressBuilder> = {
  v5r1: (publicKey, network) =>
    WalletContractV5R1.create({
      publicKey,
      // В walletId V5R1 участвует network global id (-239 mainnet, -3 testnet),
      // поэтому testnet- и mainnet-адреса одного ключа различаются.
      walletId: {
        networkGlobalId: NETWORK_GLOBAL_ID[network],
        context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber: 0 },
      },
    }).address,
};

export function getWalletAddress(
  keyPair: Pick<KeyPair, 'publicKey'>,
  options: GetWalletAddressOptions,
): WalletAddress {
  const address = ADDRESS_BUILDERS[options.version](keyPair.publicKey, options.network);
  const testOnly = options.network === 'testnet';
  return {
    raw: address.toRawString(),
    bounceable: address.toString({ urlSafe: true, bounceable: true, testOnly }),
    nonBounceable: address.toString({ urlSafe: true, bounceable: false, testOnly }),
  };
}
