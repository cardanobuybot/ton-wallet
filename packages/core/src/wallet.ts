import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import type { KeyPair } from '@ton/crypto';

// v4r2/v3r2 — только для импорта существующих кошельков; новые — только v5r1
export type WalletVersion = 'v5r1' | 'v4r2' | 'v3r2';
export type Network = 'testnet' | 'mainnet';

export const IMPORTABLE_VERSIONS: readonly WalletVersion[] = ['v5r1', 'v4r2', 'v3r2'];

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

export type WalletContract = WalletContractV5R1 | WalletContractV4 | WalletContractV3R2;

type ContractBuilder = (publicKey: Buffer, network: Network) => WalletContract;

/**
 * Registry версий контрактов. Новые кошельки создаются только v5r1;
 * v4r2/v3r2 существуют ради импорта (Tonkeeper и др.).
 */
const CONTRACT_BUILDERS: Record<WalletVersion, ContractBuilder> = {
  v5r1: (publicKey, network) =>
    WalletContractV5R1.create({
      publicKey,
      // В walletId V5R1 участвует network global id (-239 mainnet, -3 testnet),
      // поэтому testnet- и mainnet-адреса одного ключа различаются.
      walletId: {
        networkGlobalId: NETWORK_GLOBAL_ID[network],
        context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber: 0 },
      },
    }),
  // У v4r2/v3r2 walletId не зависит от сети (стандартный 698983191 + workchain):
  // адрес один и тот же в testnet и mainnet — так делают все основные кошельки.
  v4r2: (publicKey) => WalletContractV4.create({ workchain: 0, publicKey }),
  v3r2: (publicKey) => WalletContractV3R2.create({ workchain: 0, publicKey }),
};

export function getWalletContract(
  keyPair: Pick<KeyPair, 'publicKey'>,
  options: GetWalletAddressOptions,
): WalletContract {
  return CONTRACT_BUILDERS[options.version](keyPair.publicKey, options.network);
}

export function getWalletAddress(
  keyPair: Pick<KeyPair, 'publicKey'>,
  options: GetWalletAddressOptions,
): WalletAddress {
  const address = getWalletContract(keyPair, options).address;
  const testOnly = options.network === 'testnet';
  return {
    raw: address.toRawString(),
    bounceable: address.toString({ urlSafe: true, bounceable: true, testOnly }),
    nonBounceable: address.toString({ urlSafe: true, bounceable: false, testOnly }),
  };
}
