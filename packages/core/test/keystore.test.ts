import { describe, expect, it } from 'vitest';
import { decryptMnemonic, encryptMnemonic, KDF_ITERATIONS } from '../src/index.ts';
import { TEST_MNEMONIC } from './fixtures.ts';

const PASSWORD = 'correct horse battery staple';

describe('keystore envelope', () => {
  it('roundtrip: encrypt → decrypt возвращает мнемонику', async () => {
    const envelope = await encryptMnemonic(TEST_MNEMONIC, PASSWORD);
    await expect(decryptMnemonic(envelope, PASSWORD)).resolves.toEqual(TEST_MNEMONIC);
  });

  it('параметры конверта соответствуют требованиям', async () => {
    const e = await encryptMnemonic(TEST_MNEMONIC, PASSWORD);
    expect(e.version).toBe(1);
    expect(e.kdf.name).toBe('PBKDF2-SHA256');
    expect(e.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(Buffer.from(e.kdf.salt, 'base64')).toHaveLength(16);
    expect(e.cipher.name).toBe('AES-256-GCM');
    expect(Buffer.from(e.cipher.iv, 'base64')).toHaveLength(12);
  });

  it('соль и IV случайны на каждое шифрование', async () => {
    const [a, b] = await Promise.all([
      encryptMnemonic(TEST_MNEMONIC, PASSWORD),
      encryptMnemonic(TEST_MNEMONIC, PASSWORD),
    ]);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('неверный пароль отклоняется', async () => {
    const envelope = await encryptMnemonic(TEST_MNEMONIC, PASSWORD);
    await expect(decryptMnemonic(envelope, 'wrong')).rejects.toThrow(/Неверный пароль/);
  });

  it('повреждённый шифртекст отклоняется', async () => {
    const envelope = await encryptMnemonic(TEST_MNEMONIC, PASSWORD);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const corrupted = { ...envelope, ciphertext: bytes.toString('base64') };
    await expect(decryptMnemonic(corrupted, PASSWORD)).rejects.toThrow(/повреждённое/);
  });

  it('чужая версия конверта отклоняется', async () => {
    const envelope = await encryptMnemonic(TEST_MNEMONIC, PASSWORD);
    const alien = { ...envelope, version: 2 as unknown as 1 };
    await expect(decryptMnemonic(alien, PASSWORD)).rejects.toThrow(/формат/);
  });
});
