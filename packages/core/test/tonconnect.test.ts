import { describe, expect, it } from 'vitest';
import { Address, Cell } from '@ton/core';
import { sha256_sync, signVerify } from '@ton/crypto';
import {
  buildConnectError,
  buildConnectEvent,
  buildSendTransactionError,
  buildSendTransactionSuccess,
  buildTonProof,
  createSession,
  decryptBridgeMessage,
  encryptBridgeMessage,
  mnemonicToKeyPair,
  parseAppRequest,
  parseTonConnectLink,
  TONCONNECT_MAX_MESSAGES,
  verifyTonProof,
} from '../src/index.ts';
import { EXPECTED_TESTNET, TEST_MNEMONIC } from './fixtures.ts';

const DAPP_ID = 'ab'.repeat(32);
const REQUEST = JSON.stringify({
  manifestUrl: 'https://demo.example/tonconnect-manifest.json',
  items: [{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'nonce-123' }],
});

describe('parseTonConnectLink', () => {
  it('разбирает tc://-ссылку', () => {
    const link = `tc://?v=2&id=${DAPP_ID}&r=${encodeURIComponent(REQUEST)}`;
    const parsed = parseTonConnectLink(link);
    expect(parsed.version).toBe(2);
    expect(parsed.dAppClientId).toBe(DAPP_ID);
    expect(parsed.manifestUrl).toBe('https://demo.example/tonconnect-manifest.json');
    expect(parsed.items).toEqual([
      { name: 'ton_addr' },
      { name: 'ton_proof', payload: 'nonce-123' },
    ]);
  });

  it('разбирает universal-ссылку https://', () => {
    const link = `https://app.tonkeeper.com/ton-connect?v=2&id=${DAPP_ID.toUpperCase()}&r=${encodeURIComponent(REQUEST)}`;
    const parsed = parseTonConnectLink(link);
    expect(parsed.dAppClientId).toBe(DAPP_ID); // нормализация в lower-case
  });

  it('режет мусор', () => {
    expect(() => parseTonConnectLink('не ссылка')).toThrow();
    expect(() => parseTonConnectLink('tc://?v=2&id=abc')).toThrow(/v, id, r/);
    expect(() => parseTonConnectLink(`tc://?v=3&id=${DAPP_ID}&r=${encodeURIComponent(REQUEST)}`)).toThrow(/версия/);
    expect(() => parseTonConnectLink(`tc://?v=2&id=zz&r=${encodeURIComponent(REQUEST)}`)).toThrow(/hex/);
    expect(() => parseTonConnectLink(`tc://?v=2&id=${DAPP_ID}&r=notjson`)).toThrow(/JSON/);
  });

  it('требует https-manifestUrl и ton_addr в items', () => {
    const noAddr = JSON.stringify({
      manifestUrl: 'https://x.example/m.json',
      items: [{ name: 'ton_proof', payload: 'p' }],
    });
    expect(() => parseTonConnectLink(`tc://?v=2&id=${DAPP_ID}&r=${encodeURIComponent(noAddr)}`)).toThrow(/ton_addr/);
    const httpManifest = JSON.stringify({
      manifestUrl: 'http://x.example/m.json',
      items: [{ name: 'ton_addr' }],
    });
    expect(() =>
      parseTonConnectLink(`tc://?v=2&id=${DAPP_ID}&r=${encodeURIComponent(httpManifest)}`),
    ).toThrow(/https/);
  });
});

describe('bridge crypto', () => {
  it('шифрование → расшифровка на другой стороне (roundtrip)', () => {
    const wallet = createSession();
    const dapp = createSession(); // изображаем dApp второй NaCl-парой
    const json = JSON.stringify({ method: 'disconnect', params: [], id: '7' });
    const encrypted = encryptBridgeMessage(json, dapp.publicKeyHex, wallet);
    const decrypted = decryptBridgeMessage(encrypted, wallet.publicKeyHex, dapp);
    expect(decrypted).toBe(json);
  });

  it('битый шифротекст и чужой ключ → throw', () => {
    const wallet = createSession();
    const dapp = createSession();
    const stranger = createSession();
    const encrypted = encryptBridgeMessage('{"id":"1"}', dapp.publicKeyHex, wallet);
    expect(() => decryptBridgeMessage(encrypted, stranger.publicKeyHex, dapp)).toThrow();
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(() =>
      decryptBridgeMessage(bytes.toString('base64'), wallet.publicKeyHex, dapp),
    ).toThrow();
    expect(() => decryptBridgeMessage('AAAA', wallet.publicKeyHex, dapp)).toThrow(/коротк/);
  });

  it('ключи сессии — валидный hex по 32 байта', () => {
    const s = createSession();
    expect(s.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(s.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildTonProof', () => {
  it('подпись проверяется по схеме ton-proof-item-v2', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const timestamp = 1_752_700_000;
    const domain = 'demo.example';
    const payload = 'nonce-123';
    const reply = buildTonProof({
      keyPair,
      address: EXPECTED_TESTNET.raw,
      domain,
      payload,
      timestamp,
    });
    expect(reply.proof.timestamp).toBe(timestamp);
    expect(reply.proof.domain).toEqual({ lengthBytes: 12, value: domain });
    expect(reply.proof.payload).toBe(payload);

    // Пересобираем message и проверяем подпись независимо
    const addr = Address.parse(EXPECTED_TESTNET.raw);
    const wc = Buffer.alloc(4);
    wc.writeInt32BE(addr.workChain);
    const domainLen = Buffer.alloc(4);
    domainLen.writeUInt32LE(domain.length);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64LE(BigInt(timestamp));
    const message = Buffer.concat([
      Buffer.from('ton-proof-item-v2/'),
      wc,
      addr.hash,
      domainLen,
      Buffer.from(domain),
      ts,
      Buffer.from(payload),
    ]);
    const toSign = sha256_sync(
      Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256_sync(message)]),
    );
    const ok = signVerify(toSign, Buffer.from(reply.proof.signature, 'base64'), keyPair.publicKey);
    expect(ok).toBe(true);
  });
});

describe('verifyTonProof', () => {
  it('принимает валидный proof, собранный buildTonProof', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const timestamp = 1_752_700_000;
    const reply = buildTonProof({
      keyPair,
      address: EXPECTED_TESTNET.raw,
      domain: 'grampocket.com',
      payload: 'register:@alice',
      timestamp,
    });
    const ok = verifyTonProof({
      address: EXPECTED_TESTNET.raw,
      publicKeyHex: keyPair.publicKey.toString('hex'),
      domain: 'grampocket.com',
      payload: 'register:@alice',
      timestamp,
      signatureBase64: reply.proof.signature,
    });
    expect(ok).toBe(true);
  });

  it('режет подпись, собранную для другого домена/payload/адреса/timestamp/pubkey', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const timestamp = 1_752_700_000;
    const good = buildTonProof({
      keyPair,
      address: EXPECTED_TESTNET.raw,
      domain: 'grampocket.com',
      payload: 'p',
      timestamp,
    });
    const base = {
      address: EXPECTED_TESTNET.raw,
      publicKeyHex: keyPair.publicKey.toString('hex'),
      domain: 'grampocket.com',
      payload: 'p',
      timestamp,
      signatureBase64: good.proof.signature,
    } as const;
    expect(verifyTonProof({ ...base, domain: 'evil.com' })).toBe(false);
    expect(verifyTonProof({ ...base, payload: 'q' })).toBe(false);
    expect(verifyTonProof({ ...base, timestamp: timestamp + 1 })).toBe(false);
    // Другой адрес → другой addr.hash → подпись не сходится
    expect(
      verifyTonProof({
        ...base,
        address: '0:' + 'ff'.repeat(32),
      }),
    ).toBe(false);
    // Подмена pubkey → verify не пройдёт
    const bogus = Buffer.alloc(32, 0).toString('hex');
    expect(verifyTonProof({ ...base, publicKeyHex: bogus })).toBe(false);
  });

  it('режет подпись длиной != 64 и pubkey длиной != 32', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const good = buildTonProof({
      keyPair,
      address: EXPECTED_TESTNET.raw,
      domain: 'd',
      payload: 'p',
      timestamp: 1,
    });
    expect(
      verifyTonProof({
        address: EXPECTED_TESTNET.raw,
        publicKeyHex: keyPair.publicKey.toString('hex'),
        domain: 'd',
        payload: 'p',
        timestamp: 1,
        signatureBase64: Buffer.alloc(60).toString('base64'),
      }),
    ).toBe(false);
    expect(
      verifyTonProof({
        address: EXPECTED_TESTNET.raw,
        publicKeyHex: '00'.repeat(16),
        domain: 'd',
        payload: 'p',
        timestamp: 1,
        signatureBase64: good.proof.signature,
      }),
    ).toBe(false);
  });
});

describe('buildConnectEvent', () => {
  it('ton_addr: raw-адрес, сеть -3, publicKey, декодируемый stateInit', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const event = buildConnectEvent({
      id: 1,
      keyPair,
      version: 'v5r1',
      network: 'testnet',
      items: [{ name: 'ton_addr' }],
      appName: 'GramPocket',
      appVersion: '0.1.0',
    }) as {
      event: string;
      id: number;
      payload: {
        items: {
          name: string;
          address: string;
          network: string;
          publicKey: string;
          walletStateInit: string;
        }[];
        device: { maxProtocolVersion: number; features: { name: string; maxMessages: number }[] };
      };
    };
    expect(event.event).toBe('connect');
    const addrItem = event.payload.items[0]!;
    expect(addrItem.name).toBe('ton_addr');
    expect(addrItem.address).toBe(EXPECTED_TESTNET.raw);
    expect(addrItem.network).toBe('-3');
    expect(addrItem.publicKey).toBe(Buffer.from(keyPair.publicKey).toString('hex'));
    expect(() => Cell.fromBase64(addrItem.walletStateInit)).not.toThrow();
    expect(event.payload.device.features).toEqual([
      { name: 'SendTransaction', maxMessages: TONCONNECT_MAX_MESSAGES },
    ]);
  });

  it('ton_proof входит в ответ, без домена — throw', async () => {
    const keyPair = await mnemonicToKeyPair(TEST_MNEMONIC);
    const base = {
      id: 2,
      keyPair,
      version: 'v5r1' as const,
      network: 'testnet' as const,
      items: [{ name: 'ton_addr' } as const, { name: 'ton_proof', payload: 'p' } as const],
      appName: 'GramPocket',
      appVersion: '0.1.0',
      timestamp: 1_752_700_000,
    };
    const event = buildConnectEvent({ ...base, domain: 'demo.example' }) as {
      payload: { items: { name: string }[] };
    };
    expect(event.payload.items.map((i) => i.name)).toEqual(['ton_addr', 'ton_proof']);
    expect(() => buildConnectEvent(base)).toThrow(/домен/);
  });

  it('connect_error имеет форму протокола', () => {
    expect(buildConnectError(3, 300, 'Пользователь отклонил')).toEqual({
      event: 'connect_error',
      id: 3,
      payload: { code: 300, message: 'Пользователь отклонил' },
    });
  });
});

describe('parseAppRequest', () => {
  const sendTx = (params: object) =>
    JSON.stringify({ method: 'sendTransaction', params: [JSON.stringify(params)], id: '42' });

  it('разбирает sendTransaction', () => {
    const parsed = parseAppRequest(
      sendTx({
        valid_until: 1_752_700_300,
        network: '-3',
        messages: [
          { address: EXPECTED_TESTNET.raw, amount: '1000000000' },
          { address: EXPECTED_TESTNET.bounceable, amount: 5, payload: 'te6cc==', stateInit: 'te6cc==' },
        ],
      }),
    );
    expect(parsed.kind).toBe('sendTransaction');
    if (parsed.kind !== 'sendTransaction') throw new Error('unreachable');
    expect(parsed.request.id).toBe('42');
    expect(parsed.request.validUntil).toBe(1_752_700_300);
    expect(parsed.request.network).toBe('-3');
    expect(parsed.request.messages[0]).toEqual({
      address: EXPECTED_TESTNET.raw,
      amount: 1_000_000_000n,
    });
    expect(parsed.request.messages[1]!.payload).toBe('te6cc==');
  });

  it('режет мусор: >4 сообщений, пустой список, битый адрес, отрицательная сумма', () => {
    const msg = { address: EXPECTED_TESTNET.raw, amount: '1' };
    expect(() => parseAppRequest(sendTx({ messages: Array(5).fill(msg) }))).toThrow(/много/);
    expect(() => parseAppRequest(sendTx({ messages: [] }))).toThrow(/без сообщений/);
    expect(() => parseAppRequest(sendTx({ messages: [{ address: 'мусор', amount: '1' }] }))).toThrow();
    expect(() =>
      parseAppRequest(sendTx({ messages: [{ address: EXPECTED_TESTNET.raw, amount: '-5' }] })),
    ).toThrow(/Отрицательная/);
  });

  it('disconnect и неизвестный метод', () => {
    expect(parseAppRequest(JSON.stringify({ method: 'disconnect', params: [], id: '9' }))).toEqual({
      kind: 'disconnect',
      id: '9',
    });
    expect(parseAppRequest(JSON.stringify({ method: 'signData', params: [], id: '10' }))).toEqual({
      kind: 'unknown',
      id: '10',
      method: 'signData',
    });
  });
});

describe('ответы кошелька', () => {
  it('success и error формы', () => {
    expect(buildSendTransactionSuccess('42', 'te6cc==')).toEqual({ result: 'te6cc==', id: '42' });
    expect(buildSendTransactionError('42', 300, 'Отклонено')).toEqual({
      error: { code: 300, message: 'Отклонено' },
      id: '42',
    });
  });
});
