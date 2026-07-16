import { describe, expect, it } from 'vitest';
import { Address } from '@ton/core';
import { formatAddress, parseRecipientAddress } from '../src/index.ts';
import { EXPECTED_MAINNET, EXPECTED_TESTNET } from './fixtures.ts';

describe('parseRecipientAddress', () => {
  it('принимает raw в любой сети', () => {
    const p = parseRecipientAddress(EXPECTED_TESTNET.raw, 'testnet');
    expect(p.source).toBe('raw');
    expect(p.address.toRawString()).toBe(EXPECTED_TESTNET.raw);
  });

  it('принимает friendly своей сети (bounceable и non-bounceable)', () => {
    expect(parseRecipientAddress(EXPECTED_TESTNET.bounceable, 'testnet').source).toBe('friendly');
    expect(
      parseRecipientAddress(` ${EXPECTED_TESTNET.nonBounceable} `, 'testnet').address.toRawString(),
    ).toBe(EXPECTED_TESTNET.raw);
    expect(parseRecipientAddress(EXPECTED_MAINNET.bounceable, 'mainnet').source).toBe('friendly');
  });

  it('режет friendly чужой сети', () => {
    expect(() => parseRecipientAddress(EXPECTED_MAINNET.bounceable, 'testnet')).toThrow(/mainnet/);
    expect(() => parseRecipientAddress(EXPECTED_MAINNET.nonBounceable, 'testnet')).toThrow();
    expect(() => parseRecipientAddress(EXPECTED_TESTNET.bounceable, 'mainnet')).toThrow(/testnet/);
  });

  it('режет мусор', () => {
    for (const bad of ['', 'hello', '0:xyz', '0:123', EXPECTED_TESTNET.bounceable.slice(0, -2)]) {
      expect(() => parseRecipientAddress(bad, 'testnet'), bad).toThrow();
    }
  });
});

describe('formatAddress', () => {
  it('по умолчанию non-bounceable с сетевым флагом', () => {
    const addr = Address.parseRaw(EXPECTED_TESTNET.raw);
    expect(formatAddress(addr, 'testnet')).toBe(EXPECTED_TESTNET.nonBounceable);
    expect(formatAddress(addr, 'testnet', { bounceable: true })).toBe(EXPECTED_TESTNET.bounceable);
  });
});
