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

export const emulate = (boc: string, senderAddress: string) =>
  call<{
    ok: boolean;
    event?: unknown;
    rejected?: boolean;
    error?: string;
    emulatorBalance?: string;
  }>(`/emulate`, { boc, senderAddress });
