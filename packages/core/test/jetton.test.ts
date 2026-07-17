import { describe, expect, it } from 'vitest';
import { Address } from '@ton/core';
import {
  buildJettonTransferBody,
  formatTokenAmount,
  JETTON_FORWARD_TON,
  JETTON_TRANSFER_OPCODE,
  parseTokenAmount,
} from '../src/index.ts';

const TO = Address.parseRaw('0:31b41281f1bee3817f454e39740eac30a0763913fa4f9e24a7d6d178fd322684');
const RESPONSE = Address.parseRaw(
  '0:a13fc2b770396f4dd0984d3bf9098ee7506246e674072dff5fb3092e707fa81b',
);

describe('buildJettonTransferBody (TEP-74)', () => {
  it('сериализует все поля по схеме transfer#0f8a7ea5', () => {
    const cell = buildJettonTransferBody({
      amount: 123_456n,
      to: TO,
      responseTo: RESPONSE,
      comment: 'hi',
      queryId: 7n,
    });
    const s = cell.beginParse();
    expect(s.loadUint(32)).toBe(JETTON_TRANSFER_OPCODE);
    expect(s.loadUintBig(64)).toBe(7n);
    expect(s.loadCoins()).toBe(123_456n);
    expect(s.loadAddress().equals(TO)).toBe(true);
    expect(s.loadAddress().equals(RESPONSE)).toBe(true);
    expect(s.loadMaybeRef()).toBeNull(); // custom_payload
    expect(s.loadCoins()).toBe(JETTON_FORWARD_TON);
    const forward = s.loadMaybeRef();
    expect(forward).not.toBeNull();
    const fs = forward!.beginParse();
    expect(fs.loadUint(32)).toBe(0); // text comment opcode
    expect(fs.loadStringTail()).toBe('hi');
    expect(s.remainingBits).toBe(0);
  });

  it('без комментария: forward_payload — пустая left-ветка, queryId=0', () => {
    const s = buildJettonTransferBody({ amount: 1n, to: TO, responseTo: RESPONSE }).beginParse();
    s.loadUint(32);
    expect(s.loadUintBig(64)).toBe(0n);
    s.loadCoins();
    s.loadAddress();
    s.loadAddress();
    s.loadMaybeRef();
    s.loadCoins();
    expect(s.loadMaybeRef()).toBeNull();
  });

  it('детерминирован', () => {
    const p = { amount: 5n, to: TO, responseTo: RESPONSE, comment: 'x' };
    expect(buildJettonTransferBody(p).hash().toString('hex')).toBe(
      buildJettonTransferBody(p).hash().toString('hex'),
    );
  });
});

describe('parseTokenAmount / formatTokenAmount', () => {
  it('уважает decimals джеттона', () => {
    expect(parseTokenAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseTokenAmount('0,000001', 6)).toBe(1n);
    expect(parseTokenAmount('42', 0)).toBe(42n);
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatTokenAmount(-1n, 6)).toBe('-0.000001');
    expect(formatTokenAmount(42n, 0)).toBe('42');
  });

  it('лишние знаки и мусор отклоняются', () => {
    expect(() => parseTokenAmount('1.2345678', 6)).toThrow();
    expect(() => parseTokenAmount('0.1', 0)).toThrow();
    expect(() => parseTokenAmount('1e6', 6)).toThrow();
    expect(() => parseTokenAmount('', 6)).toThrow();
    expect(() => parseTokenAmount('1', 1.5)).toThrow();
  });
});
