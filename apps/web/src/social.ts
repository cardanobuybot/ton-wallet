// Клиентская обёртка для соц-эндпоинтов apps/api: подписывает ton_proof
// с сессионным ключом и формирует полезную нагрузку в форме, ожидаемой сервером.
import { buildTonProof } from '@ton-wallet/core';
import type { WalletAddress, WalletVersion } from '@ton-wallet/core';
import type { Session } from './session.ts';
import type { SocialAuthPayload } from './api.ts';

/** Домен, к которому привязан proof; сервер сверяется с TONPROOF_DOMAIN. */
export const TONPROOF_DOMAIN =
  (import.meta.env.VITE_TONPROOF_DOMAIN as string | undefined) ?? 'grampocket.com';

/**
 * Подписывает proof владения адресом. `proofPayload` — уникальное действие,
 * напр. `register:@alice` или `follow:0:abcd…` — сервер сравнит буквально.
 */
export function signSocialProof(
  session: Session,
  address: WalletAddress,
  version: WalletVersion,
  proofPayload: string,
): SocialAuthPayload {
  const timestamp = Math.floor(Date.now() / 1000);
  const reply = buildTonProof({
    keyPair: session.keyPair,
    address: address.raw,
    domain: TONPROOF_DOMAIN,
    payload: proofPayload,
    timestamp,
  });
  return {
    address: address.raw,
    publicKeyHex: session.keyPair.publicKey.toString('hex'),
    walletVersion: version,
    network: 'testnet',
    timestamp,
    signatureBase64: reply.proof.signature,
  };
}
