// Соцфичи: @username через ton_proof + подписки.
// Сервер НИКОГДА не касается приватных ключей. Все действия
// (регистрация ника, подписка/отписка) требуют proof владения адресом,
// подписанный клиентом на своей стороне; сервер проверяет подпись публичным ключом.
import type { FastifyInstance } from 'fastify';
import {
  getWalletAddress,
  IMPORTABLE_VERSIONS,
  verifyTonProof,
  type Network,
  type WalletVersion,
} from '@ton-wallet/core';
import { sql } from './db.ts';

const DOMAIN = process.env.TONPROOF_DOMAIN ?? 'grampocket.com';
/** Окно приёма proof: 5 минут в обе стороны — компромисс между защитой от replay
 * и рассинхроном часов на устройстве пользователя. */
const PROOF_WINDOW_SECONDS = 5 * 60;

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  'admin',
  'system',
  'root',
  'api',
  'me',
  'you',
  'ton',
  'wallet',
  'tonconnect',
  'support',
  'help',
  'null',
  'undefined',
  'test',
]);

interface AuthPayload {
  address: string;
  publicKeyHex: string;
  walletVersion: string;
  network: string;
  timestamp: number;
  signatureBase64: string;
}

interface AuthResult {
  addressRaw: string;
}

/**
 * Проверяет proof владения адресом. Возвращает нормализованный raw-адрес
 * (нижний регистр hex). Кидает `Error` с `.statusCode` для fastify.
 */
function authorize(payload: AuthPayload, proofPayload: string): AuthResult {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - payload.timestamp) > PROOF_WINDOW_SECONDS) {
    throw badRequest('Proof устарел (или часы устройства сбиты)');
  }
  if (payload.network !== 'testnet' && payload.network !== 'mainnet') {
    throw badRequest('Неверная сеть');
  }
  if (!(IMPORTABLE_VERSIONS as readonly string[]).includes(payload.walletVersion)) {
    throw badRequest('Неизвестная версия кошелька');
  }
  const network = payload.network as Network;
  const version = payload.walletVersion as WalletVersion;

  // publicKey → адрес должен совпасть с заявленным
  const publicKey = Buffer.from(payload.publicKeyHex, 'hex');
  if (publicKey.length !== 32) throw badRequest('Неверная длина publicKey');
  const derived = getWalletAddress({ publicKey }, { version, network });
  const claimedRaw = normalizeRaw(payload.address);
  if (derived.raw !== claimedRaw) {
    throw badRequest('publicKey не соответствует адресу');
  }

  const ok = verifyTonProof({
    address: claimedRaw,
    publicKeyHex: payload.publicKeyHex,
    domain: DOMAIN,
    payload: proofPayload,
    timestamp: payload.timestamp,
    signatureBase64: payload.signatureBase64,
  });
  if (!ok) throw badRequest('Подпись proof не сходится');

  return { addressRaw: claimedRaw };
}

function normalizeRaw(address: string): string {
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address.trim());
  if (!m) throw badRequest('Ожидался raw-адрес (`workchain:hash`)');
  return `${m[1]}:${m[2]!.toLowerCase()}`;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function requireDb() {
  const s = sql();
  if (!s) throw Object.assign(new Error('БД не настроена'), { statusCode: 503 });
  return s;
}

export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: AuthPayload & { username: string };
  }>('/username/register', async (request, reply) => {
    const { username } = request.body;
    const clean = username.trim().toLowerCase();
    if (!USERNAME_RE.test(clean)) {
      return reply.code(400).send({ error: 'Ник: 3–20 знаков, только a–z, 0–9, _' });
    }
    if (RESERVED_USERNAMES.has(clean)) {
      return reply.code(400).send({ error: 'Этот ник зарезервирован' });
    }
    const { addressRaw } = authorize(request.body, `register:@${clean}`);
    const s = requireDb();
    try {
      await s`INSERT INTO usernames (address_raw, username)
              VALUES (${addressRaw}, ${clean})`;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        return reply.code(409).send({ error: 'Адрес уже с ником, либо ник занят' });
      }
      throw err;
    }
    return { username: clean, addressRaw };
  });

  app.get<{ Params: { name: string } }>('/username/:name', async (request, reply) => {
    const clean = request.params.name.replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(clean)) return reply.code(400).send({ error: 'Некорректный ник' });
    const s = requireDb();
    const rows = await s<
      { address_raw: string; username: string }[]
    >`SELECT address_raw, username FROM usernames WHERE lower(username) = ${clean}`;
    if (rows.length === 0) return reply.code(404).send({ error: 'Ник не найден' });
    return { username: rows[0]!.username, addressRaw: rows[0]!.address_raw };
  });

  app.get<{ Params: { raw: string } }>('/address/:raw/social', async (request) => {
    const raw = normalizeRaw(request.params.raw);
    const s = requireDb();
    const [uRow] = await s<
      { username: string }[]
    >`SELECT username FROM usernames WHERE address_raw = ${raw}`;
    const [[followers], [following]] = await Promise.all([
      s<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM follows WHERE target_raw = ${raw}`,
      s<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM follows WHERE follower_raw = ${raw}`,
    ]);
    return {
      username: uRow?.username ?? null,
      followers: Number(followers?.n ?? '0'),
      following: Number(following?.n ?? '0'),
    };
  });

  app.post<{
    Body: AuthPayload & { target: string };
  }>('/follows/register', async (request, reply) => {
    const target = normalizeRaw(request.body.target);
    const { addressRaw } = authorize(request.body, `follow:${target}`);
    if (addressRaw === target) {
      return reply.code(400).send({ error: 'Нельзя подписаться на себя' });
    }
    const s = requireDb();
    await s`INSERT INTO follows (follower_raw, target_raw)
            VALUES (${addressRaw}, ${target})
            ON CONFLICT DO NOTHING`;
    return { ok: true };
  });

  app.post<{
    Body: AuthPayload & { target: string };
  }>('/follows/unregister', async (request) => {
    const target = normalizeRaw(request.body.target);
    const { addressRaw } = authorize(request.body, `unfollow:${target}`);
    const s = requireDb();
    await s`DELETE FROM follows
            WHERE follower_raw = ${addressRaw} AND target_raw = ${target}`;
    return { ok: true };
  });

  app.get<{
    Params: { raw: string };
    Querystring: { limit?: string };
  }>('/follows/of/:raw', async (request) => {
    const raw = normalizeRaw(request.params.raw);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const s = requireDb();
    const rows = await s<
      { target_raw: string; username: string | null }[]
    >`SELECT f.target_raw, u.username
        FROM follows f
        LEFT JOIN usernames u ON u.address_raw = f.target_raw
       WHERE f.follower_raw = ${raw}
       ORDER BY f.created_at DESC
       LIMIT ${limit}`;
    return { items: rows.map((r) => ({ addressRaw: r.target_raw, username: r.username })) };
  });

  app.get<{
    Params: { raw: string };
    Querystring: { limit?: string };
  }>('/followers/:raw', async (request) => {
    const raw = normalizeRaw(request.params.raw);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const s = requireDb();
    const rows = await s<
      { follower_raw: string; username: string | null }[]
    >`SELECT f.follower_raw, u.username
        FROM follows f
        LEFT JOIN usernames u ON u.address_raw = f.follower_raw
       WHERE f.target_raw = ${raw}
       ORDER BY f.created_at DESC
       LIMIT ${limit}`;
    return { items: rows.map((r) => ({ addressRaw: r.follower_raw, username: r.username })) };
  });
}
