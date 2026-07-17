import { describe, expect, it } from 'vitest';
import { getWalletAddress, mnemonicToKeyPair, IMPORTABLE_VERSIONS } from '../src/index.ts';
import {
  EXPECTED_MAINNET,
  EXPECTED_TESTNET,
  EXPECTED_V3R2,
  EXPECTED_V4R2,
  TEST_MNEMONIC,
} from './fixtures.ts';

describe('getWalletAddress (v5r1)', () => {
  it('фиксированная мнемоника → ожидаемый testnet-адрес', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const addr = getWalletAddress(kp, { version: 'v5r1', network: 'testnet' });
    expect(addr).toEqual(EXPECTED_TESTNET);
  });

  it('фиксированная мнемоника → ожидаемый mainnet-адрес', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const addr = getWalletAddress(kp, { version: 'v5r1', network: 'mainnet' });
    expect(addr).toEqual(EXPECTED_MAINNET);
  });

  it('testnet-адрес != mainnet-адрес (network global id в walletId)', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const testnet = getWalletAddress(kp, { version: 'v5r1', network: 'testnet' });
    const mainnet = getWalletAddress(kp, { version: 'v5r1', network: 'mainnet' });
    expect(testnet.raw).not.toBe(mainnet.raw);
  });

  it('user-friendly формы имеют ожидаемые префиксы', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const testnet = getWalletAddress(kp, { version: 'v5r1', network: 'testnet' });
    const mainnet = getWalletAddress(kp, { version: 'v5r1', network: 'mainnet' });
    expect(testnet.bounceable.startsWith('kQ')).toBe(true);
    expect(testnet.nonBounceable.startsWith('0Q')).toBe(true);
    expect(mainnet.bounceable.startsWith('EQ')).toBe(true);
    expect(mainnet.nonBounceable.startsWith('UQ')).toBe(true);
  });
});

describe('getWalletAddress (импорт v4r2/v3r2)', () => {
  it('фиксированная мнемоника → ожидаемые адреса', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const v4 = getWalletAddress(kp, { version: 'v4r2', network: 'testnet' });
    const v3 = getWalletAddress(kp, { version: 'v3r2', network: 'testnet' });
    expect(v4.raw).toBe(EXPECTED_V4R2.raw);
    expect(v4.nonBounceable).toBe(EXPECTED_V4R2.testnetNonBounceable);
    expect(v3.raw).toBe(EXPECTED_V3R2.raw);
    expect(v3.nonBounceable).toBe(EXPECTED_V3R2.testnetNonBounceable);
  });

  it('raw-адрес v4r2/v3r2 не зависит от сети (в отличие от v5r1)', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    for (const version of ['v4r2', 'v3r2'] as const) {
      const testnet = getWalletAddress(kp, { version, network: 'testnet' });
      const mainnet = getWalletAddress(kp, { version, network: 'mainnet' });
      expect(testnet.raw).toBe(mainnet.raw);
    }
  });

  it('все версии registry дают разные адреса', async () => {
    const kp = await mnemonicToKeyPair(TEST_MNEMONIC);
    const raws = IMPORTABLE_VERSIONS.map(
      (version) => getWalletAddress(kp, { version, network: 'testnet' }).raw,
    );
    expect(new Set(raws).size).toBe(raws.length);
  });
});
