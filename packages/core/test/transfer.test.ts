import { describe, expect, it } from 'vitest';
import { Address, beginCell, Cell, loadMessage, loadMessageRelaxed, storeStateInit } from '@ton/core';
import type { MessageRelaxed } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import {
  createRawTransfer,
  createTransfer,
  getWalletAddress,
  getWalletContract,
  mnemonicToKeyPair,
  resolveBounce,
  TRANSFER_TTL_SECONDS,
} from '../src/index.ts';
import { EXPECTED_MAINNET, EXPECTED_TESTNET, TEST_MNEMONIC } from './fixtures.ts';

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

describe('createRawTransfer (TON Connect)', () => {
  const PAYLOAD = 'te6cckEBAQEADgAAGNUydtsAAAAAAAAAAPfBmNw='; // excesses op — просто валидный Cell

  async function build(overrides: Partial<Parameters<typeof createRawTransfer>[0]> = {}) {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    return createRawTransfer({
      keyPair,
      version: 'v5r1',
      network: 'testnet',
      seqno: 5,
      messages: [{ address: EXPECTED_MAINNET.bounceable, amount: 100_000_000n }],
      now: NOW,
      ...overrides,
    });
  }

  it('режет 0 и >4 сообщений и просроченный valid_until', async () => {
    await expect(build({ messages: [] })).rejects.toThrow(/1–4/);
    const msg = { address: EXPECTED_MAINNET.bounceable, amount: 1n };
    await expect(build({ messages: Array(5).fill(msg) })).rejects.toThrow(/1–4/);
    await expect(build({ validUntil: NOW - 1 })).rejects.toThrow(/просрочен/);
  });

  it('validUntil из запроса уважается, но клампится к now + TTL', async () => {
    expect((await build({ validUntil: NOW + 100 })).validUntil).toBe(NOW + 100);
    expect((await build({ validUntil: NOW + 10_000 })).validUntil).toBe(NOW + TRANSFER_TTL_SECONDS);
    expect((await build()).validUntil).toBe(NOW + TRANSFER_TTL_SECONDS);
  });

  it('external адресован своему кошельку, детерминирован', async () => {
    const { bocBase64 } = await build();
    const message = loadMessage(Cell.fromBase64(bocBase64).beginParse());
    expect(message.info.type).toBe('external-in');
    expect(message.info.dest?.toString()).toBe(Address.parseRaw(EXPECTED_TESTNET.raw).toString());
    expect((await build()).bocBase64).toBe(bocBase64);
  });

  it('v4r2: dest/amount/bounce/payload внутренних сообщений верны', async () => {
    // Тело v4 легко разобрать: sig(512) · walletId · valid_until · seqno · op(8) · [mode(8)+ref]*
    const { bocBase64 } = await build({
      version: 'v4r2',
      messages: [
        { address: EXPECTED_MAINNET.bounceable, amount: 100_000_000n, payload: PAYLOAD },
        { address: EXPECTED_MAINNET.raw, amount: 5n },
      ],
    });
    const body = loadMessage(Cell.fromBase64(bocBase64).beginParse()).body.beginParse();
    body.loadBits(512);
    body.loadUint(32); // walletId
    body.loadUint(32); // valid_until
    body.loadUint(32); // seqno
    body.loadUint(8); // op
    const msgs = [];
    while (body.remainingRefs > 0) {
      body.loadUint(8); // sendMode
      msgs.push(loadMessageRelaxed(body.loadRef().beginParse()));
    }
    expect(msgs).toHaveLength(2);
    const [first, second] = msgs as [MessageRelaxed, MessageRelaxed];
    expect(first.info.type).toBe('internal');
    if (first.info.type !== 'internal' || second.info.type !== 'internal') throw new Error('unreachable');
    expect(first.info.dest.toRawString()).toBe(EXPECTED_MAINNET.raw);
    expect(first.info.value.coins).toBe(100_000_000n);
    expect(first.info.bounce).toBe(true); // EQ… — bounceable-флаг уважается
    expect(first.body.toBoc().toString('base64')).toBe(Cell.fromBase64(PAYLOAD).toBoc().toString('base64'));
    expect(second.info.bounce).toBe(false); // raw-адрес — bounce=false
    expect(second.info.value.coins).toBe(5n);
  });

  it('stateInit получателя приложен и принуждает bounce=false', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const wallet = getWalletContract(keyPair, { version: 'v4r2', network: 'testnet' });
    const stateInit = beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64');
    const { bocBase64 } = await build({
      version: 'v4r2',
      messages: [{ address: EXPECTED_MAINNET.bounceable, amount: 1n, stateInit }],
    });
    const body = loadMessage(Cell.fromBase64(bocBase64).beginParse()).body.beginParse();
    body.loadBits(512);
    body.loadUint(32);
    body.loadUint(32);
    body.loadUint(32);
    body.loadUint(8);
    body.loadUint(8);
    const msg = loadMessageRelaxed(body.loadRef().beginParse());
    if (msg.info.type !== 'internal') throw new Error('unreachable');
    expect(msg.init?.code?.toBoc().toString('base64')).toBe(wallet.init.code.toBoc().toString('base64'));
    expect(msg.info.bounce).toBe(false);
  });
});
