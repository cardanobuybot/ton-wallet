const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:3000';

export interface AccountInfo {
  balance: string;
  deployed: boolean;
  seqno: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export const getAccount = (address: string) =>
  call<AccountInfo>(`/account/${encodeURIComponent(address)}`);

export const estimateFee = (params: {
  address: string;
  body: string;
  initCode?: string;
  initData?: string;
}) => call<{ totalFee: string }>(`/estimate-fee`, params);

export const sendBoc = (boc: string) => call<{ sent: boolean }>(`/send-boc`, { boc });

export const getTransactions = (address: string, cursor?: { lt: string; hash: string }) =>
  call<{ transactions: unknown }>(
    `/transactions/${encodeURIComponent(address)}?limit=20${
      cursor ? `&lt=${encodeURIComponent(cursor.lt)}&hash=${encodeURIComponent(cursor.hash)}` : ''
    }`,
  );

export interface JettonBalance {
  jettonWallet: string;
  jettonMaster: string;
  balance: string;
  decimals: number;
  symbol?: string;
  name?: string;
}

export const getJettons = (address: string) =>
  call<{ jettons: JettonBalance[] }>(`/jettons/${encodeURIComponent(address)}`);

export interface AddressIntel {
  deployed: boolean;
  balance: string;
  txCount: number;
  txCountCapped: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
}

export const getAddressIntel = (address: string) =>
  call<AddressIntel>(`/address-intel/${encodeURIComponent(address)}`);

export const emulate = (boc: string, senderAddress: string) =>
  call<{
    ok: boolean;
    event?: unknown;
    rejected?: boolean;
    error?: string;
    emulatorBalance?: string;
  }>(`/emulate`, { boc, senderAddress });

// ---------- Соц-эндпоинты (спринт 9) ----------

/** Полезная нагрузка ton_proof для доказательства владения адресом. */
export interface SocialAuthPayload {
  address: string;
  publicKeyHex: string;
  walletVersion: string;
  network: string;
  timestamp: number;
  signatureBase64: string;
}

export interface AddressSocial {
  username: string | null;
  followers: number;
  following: number;
}

export const registerUsername = (body: SocialAuthPayload & { username: string }) =>
  call<{ username: string; addressRaw: string }>(`/username/register`, body);

export const resolveUsername = (name: string) =>
  call<{ username: string; addressRaw: string }>(
    `/username/${encodeURIComponent(name.replace(/^@/, ''))}`,
  );

export const getAddressSocial = (raw: string) =>
  call<AddressSocial>(`/address/${encodeURIComponent(raw)}/social`);

export const followAddress = (body: SocialAuthPayload & { target: string }) =>
  call<{ ok: boolean }>(`/follows/register`, body);

export const unfollowAddress = (body: SocialAuthPayload & { target: string }) =>
  call<{ ok: boolean }>(`/follows/unregister`, body);

export const listFollowing = (raw: string) =>
  call<{ items: { addressRaw: string; username: string | null }[] }>(
    `/follows/of/${encodeURIComponent(raw)}`,
  );

export const listFollowers = (raw: string) =>
  call<{ items: { addressRaw: string; username: string | null }[] }>(
    `/followers/${encodeURIComponent(raw)}`,
  );
