import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate, type KeyPair } from '@ton/crypto';

export type { KeyPair };

export const MNEMONIC_WORD_COUNT = 24;

/**
 * Генерирует мнемонику из 24 слов по TON-схеме (@ton/crypto), НЕ BIP39:
 * та же таблица слов, но другая деривация и собственная проверка seed,
 * поэтому случайная BIP39-фраза здесь невалидна.
 */
export async function generateMnemonic(): Promise<string[]> {
  return mnemonicNew(MNEMONIC_WORD_COUNT);
}

export async function validateMnemonic(words: string[]): Promise<boolean> {
  if (words.length !== MNEMONIC_WORD_COUNT) {
    return false;
  }
  return mnemonicValidate(words);
}

export async function mnemonicToKeyPair(words: string[]): Promise<KeyPair> {
  if (!(await validateMnemonic(words))) {
    throw new Error('Invalid TON mnemonic');
  }
  return mnemonicToPrivateKey(words);
}
