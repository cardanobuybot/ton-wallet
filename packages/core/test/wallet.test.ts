import { describe, expect, it } from 'vitest';
import { getWalletAddress, mnemonicToKeyPair } from '../src/index.ts';
import { EXPECTED_MAINNET, EXPECTED_TESTNET, TEST_MNEMONIC } from './fixtures.ts';

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
