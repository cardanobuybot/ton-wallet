import { describe, expect, it } from 'vitest';
import {
  MNEMONIC_WORD_COUNT,
  generateMnemonic,
  mnemonicToKeyPair,
  validateMnemonic,
} from '../src/index.ts';
import { BIP39_MNEMONIC, TEST_MNEMONIC } from './fixtures.ts';

describe('generateMnemonic', () => {
  it('возвращает 24 слова, проходящие валидацию', async () => {
    const words = await generateMnemonic();
    expect(words).toHaveLength(MNEMONIC_WORD_COUNT);
    await expect(validateMnemonic(words)).resolves.toBe(true);
  });

  it('две генерации дают разные мнемоники', async () => {
    const [a, b] = await Promise.all([generateMnemonic(), generateMnemonic()]);
    expect(a.join(' ')).not.toBe(b.join(' '));
  });
});

describe('validateMnemonic', () => {
  it('принимает фиксированную тестовую мнемонику', async () => {
    await expect(validateMnemonic(TEST_MNEMONIC)).resolves.toBe(true);
  });

  it('режет мусор', async () => {
    await expect(validateMnemonic([])).resolves.toBe(false);
    await expect(validateMnemonic(['foo', 'bar'])).resolves.toBe(false);
    await expect(validateMnemonic(Array(24).fill('notaword'))).resolves.toBe(false);
    const corrupted = [...TEST_MNEMONIC];
    corrupted[0] = 'zebra';
    await expect(validateMnemonic(corrupted)).resolves.toBe(false);
  });

  it('режет валидную BIP39-фразу (TON-схема != BIP39)', async () => {
    await expect(validateMnemonic(BIP39_MNEMONIC)).resolves.toBe(false);
  });
});

describe('mnemonicToKeyPair', () => {
  it('возвращает ed25519-пару для валидной мнемоники', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toHaveLength(64);
  });

  it('бросает на невалидной мнемонике', async () => {
    await expect(mnemonicToKeyPair(BIP39_MNEMONIC)).rejects.toThrow('Invalid TON mnemonic');
  });
});
