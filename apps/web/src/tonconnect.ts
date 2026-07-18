// Транспорт TON Connect: HTTP-бридж (SSE + POST) и манифест dApp.
// Криптография сессий — в @ton-wallet/core (tonconnect.ts).
export const BRIDGE_URL = 'https://bridge.tonapi.io/bridge';
const MESSAGE_TTL_SECONDS = 300;

export interface DappManifest {
  url: string;
  name: string;
  iconUrl?: string;
}

export async function fetchManifest(manifestUrl: string): Promise<DappManifest> {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Манифест dApp недоступен (HTTP ${res.status})`);
  const m = (await res.json()) as { url?: unknown; name?: unknown; iconUrl?: unknown };
  if (typeof m.url !== 'string' || typeof m.name !== 'string') {
    throw new Error('Манифест dApp без url/name');
  }
  return {
    url: m.url,
    name: m.name,
    ...(typeof m.iconUrl === 'string' ? { iconUrl: m.iconUrl } : {}),
  };
}

/** POST зашифрованного сообщения на мост от имени нашей сессии */
export async function postBridgeMessage(
  fromClientId: string,
  toClientId: string,
  encryptedBase64: string,
): Promise<void> {
  const url = `${BRIDGE_URL}/message?client_id=${encodeURIComponent(fromClientId)}&to=${encodeURIComponent(toClientId)}&ttl=${MESSAGE_TTL_SECONDS}`;
  const res = await fetch(url, { method: 'POST', body: encryptedBase64 });
  if (!res.ok) throw new Error(`Мост отверг сообщение (HTTP ${res.status})`);
}

export interface BridgeEvent {
  /** client_id отправителя (dApp) */
  from: string;
  /** base64(nonce ++ box) */
  message: string;
  /** курсор для last_event_id */
  eventId: string;
}

/** Открывает SSE на все наши client_id; вернувшаяся функция закрывает поток */
export function openBridgeEvents(
  clientIds: string[],
  lastEventId: string | null,
  onEvent: (event: BridgeEvent) => void,
): () => void {
  const params = new URLSearchParams({ client_id: clientIds.join(',') });
  if (lastEventId) params.set('last_event_id', lastEventId);
  const source = new EventSource(`${BRIDGE_URL}/events?${params.toString()}`);
  source.onmessage = (e: MessageEvent<string>) => {
    if (!e.data || e.data === 'heartbeat') return;
    let parsed: { from?: unknown; message?: unknown };
    try {
      parsed = JSON.parse(e.data) as { from?: unknown; message?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.from !== 'string' || typeof parsed.message !== 'string') return;
    onEvent({ from: parsed.from, message: parsed.message, eventId: e.lastEventId });
  };
  return () => source.close();
}
