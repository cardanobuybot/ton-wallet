import type { KeyPair } from '@ton-wallet/core';

export const AUTO_LOCK_MS = 5 * 60 * 1000;

export interface Session {
  keyPair: KeyPair;
  mnemonic: string[];
}

/** Зануляет ключевой материал в памяти. Вызывается при каждом локе. */
export function zeroizeSession(session: Session): void {
  session.keyPair.secretKey.fill(0);
  session.keyPair.publicKey.fill(0);
  for (let i = 0; i < session.mnemonic.length; i++) {
    session.mnemonic[i] = '';
  }
  session.mnemonic.length = 0;
}
