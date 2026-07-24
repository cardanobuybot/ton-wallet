import { describe, expect, it } from 'vitest';
import { Address } from '@ton/core';
import {
  buildNftTransferBody,
  NFT_FORWARD_TON,
  NFT_TRANSFER_OPCODE,
} from '../src/index.ts';

const NEW_OWNER = Address.parseRaw(
  '0:31b41281f1bee3817f454e39740eac30a0763913fa4f9e24a7d6d178fd322684',
);
const RESPONSE = Address.parseRaw(
  '0:a13fc2b770396f4dd0984d3bf9098ee7506246e674072dff5fb3092e707fa81b',
);

describe('buildNftTransferBody (TEP-62)', () => {
  it('сериализует все поля по схеме transfer#5fcc3d14', () => {
    const cell = buildNftTransferBody({
      newOwner: NEW_OWNER,
      responseTo: RESPONSE,
      comment: 'gift',
      queryId: 42n,
    });
    const s = cell.beginParse();
    expect(s.loadUint(32)).toBe(NFT_TRANSFER_OPCODE);
    expect(s.loadUintBig(64)).toBe(42n);
    expect(s.loadAddress().equals(NEW_OWNER)).toBe(true);
    expect(s.loadAddress().equals(RESPONSE)).toBe(true);
    expect(s.loadMaybeRef()).toBeNull(); // custom_payload
    expect(s.loadCoins()).toBe(NFT_FORWARD_TON);
    const forward = s.loadMaybeRef();
    expect(forward).not.toBeNull();
    const fs = forward!.beginParse();
    expect(fs.loadUint(32)).toBe(0); // text comment opcode
    expect(fs.loadStringTail()).toBe('gift');
    expect(s.remainingBits).toBe(0);
  });

  it('без комментария: forward_payload пуст, queryId=0', () => {
    const s = buildNftTransferBody({ newOwner: NEW_OWNER, responseTo: RESPONSE }).beginParse();
    s.loadUint(32);
    expect(s.loadUintBig(64)).toBe(0n);
    s.loadAddress();
    s.loadAddress();
    s.loadMaybeRef();
    s.loadCoins();
    expect(s.loadMaybeRef()).toBeNull();
  });

  it('детерминирован при фиксированных входах', () => {
    const p = { newOwner: NEW_OWNER, responseTo: RESPONSE, comment: 'hey' };
    expect(buildNftTransferBody(p).hash().toString('hex')).toBe(
      buildNftTransferBody(p).hash().toString('hex'),
    );
  });
});
