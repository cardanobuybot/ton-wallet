import { describe, expect, it } from 'vitest';
import { Address, Cell, loadMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import {
  createTransfer,
  getWalletAddress,
  mnemonicToKeyPair,
  resolveBounce,
  TRANSFER_TTL_SECONDS,
} from '../src/index.ts';
import { EXPECTED_TESTNET, TEST_MNEMONIC } from './fixtures.ts';

const NOW = 1_752_000_000;
const RECIPIENT = Address.parseRaw(
  '0:31b41281f1bee3817f454e39740eac30a0763913fa4f9e24a7d6d178fd322684',
);

describe('resolveBounce', () => {
  it('принудительно false для незадеплоенного получателя', () => {
    expect(resolveBounce(true, false)).toBe(false);
    expect(resolveBounce(false, false)).toBe(false);
  });

  it('уважает запрошенный флаг для задеплоенного', () => {
    expect(resolveBounce(true, true)).toBe(true);
    expect(resolveBounce(false, true)).toBe(false);
  });
});

describe('createTransfer (v5r1)', () => {
  async function build(seqno = 5) {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    return createTransfer({
      keyPair,
      version: 'v5r1',
      network: 'testnet',
      seqno,
      to: RECIPIENT,
      amount: 100_000_000n,
      bounce: false,
      comment: 'test',
      now: NOW,
    });
  }

  it('validUntil = now + 5 минут', async () => {
    const { validUntil } = await build();
    expect(validUntil).toBe(NOW + TRANSFER_TTL_SECONDS);
    expect(TRANSFER_TTL_SECONDS).toBe(300);
  });

  it('external адресован кошельку отправителя, тело подписано верным opcode', async () => {
    const { bocBase64 } = await build();
    const message = loadMessage(Cell.fromBase64(bocBase64).beginParse());
    expect(message.info.type).toBe('external-in');
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const selfAddress = getWalletAddress(keyPair, { version: 'v5r1', network: 'testnet' });
    expect(message.info.dest?.toString()).toBe(Address.parseRaw(EXPECTED_TESTNET.raw).toString());
    expect(selfAddress.raw).toBe(EXPECTED_TESTNET.raw);

    const body = message.body.beginParse();
    expect(body.loadUint(32)).toBe(WalletContractV5R1.OpCodes.auth_signed_external);
    body.loadUint(32); // walletId
    expect(body.loadUint(32)).toBe(NOW + TRANSFER_TTL_SECONDS); // valid_until
    expect(body.loadUint(32)).toBe(5); // seqno
  });

  it('seqno=0 включает stateInit (деплой), seqno>0 — нет', async () => {
    const deploy = loadMessage(Cell.fromBase64((await build(0)).bocBase64).beginParse());
    const regular = loadMessage(Cell.fromBase64((await build(5)).bocBase64).beginParse());
    expect(deploy.init).not.toBeNull();
    expect(regular.init).toBeNull();
  });

  it('детерминирован при фиксированных входах', async () => {
    expect((await build()).bocBase64).toBe((await build()).bocBase64);
  });
});

describe('createTransfer (импорт v4r2/v3r2)', () => {
  async function build(version: 'v4r2' | 'v3r2', seqno = 5) {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    return createTransfer({
      keyPair,
      version,
      network: 'testnet',
      seqno,
      to: RECIPIENT,
      amount: 100_000_000n,
      bounce: false,
      comment: 'test',
      now: NOW,
    });
  }

  for (const version of ['v4r2', 'v3r2'] as const) {
    it(`${version}: external адресован своему кошельку, valid_until и seqno в теле`, async () => {
      const { bocBase64, validUntil } = await build(version);
      const message = loadMessage(Cell.fromBase64(bocBase64).beginParse());
      expect(message.info.type).toBe('external-in');
      const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
      const self = getWalletAddress(keyPair, { version, network: 'testnet' });
      expect(message.info.dest?.toString()).toBe(Address.parseRaw(self.raw).toString());

      // Тело v3/v4: signature(512) · walletId(32) · valid_until(32) · seqno(32)
      const body = message.body.beginParse();
      body.loadBits(512);
      expect(body.loadUint(32)).toBe(698983191); // стандартный walletId
      expect(body.loadUint(32)).toBe(validUntil);
      expect(body.loadUint(32)).toBe(5);
    });

    it(`${version}: seqno=0 включает stateInit, детерминирован`, async () => {
      const deploy = loadMessage(Cell.fromBase64((await build(version, 0)).bocBase64).beginParse());
      expect(deploy.init).not.toBeNull();
      expect((await build(version)).bocBase64).toBe((await build(version)).bocBase64);
    });
  }
});
