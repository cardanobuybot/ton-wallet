import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildConnectError,
  buildConnectEvent,
  buildSendTransactionError,
  createSession,
  decryptBridgeMessage,
  encryptBridgeMessage,
  parseAppRequest,
  parseTonConnectLink,
  TONCONNECT_USER_DECLINED,
  type SendTransactionRequest,
  type TonConnectLink,
  type WalletVersion,
} from '@ton-wallet/core';
import { fetchManifest, openBridgeEvents, postBridgeMessage, type DappManifest } from './tonconnect.ts';
import {
  deleteTonConnectConnection,
  listTonConnectConnections,
  loadTcLastEventId,
  saveTcLastEventId,
  saveTonConnectConnection,
  type TonConnectConnection,
} from './storage.ts';
import type { Session } from './session.ts';

const NETWORK = 'testnet' as const;
const APP_NAME = 'ton-wallet';
const APP_VERSION = '0.7.0';

export interface DappTxRequest {
  connection: TonConnectConnection;
  request: SendTransactionRequest;
  /** Шифрует и отправляет JSON-ответ dApp через мост */
  reply: (json: string) => Promise<void>;
}

interface PendingConnect {
  link: TonConnectLink;
  manifest: DappManifest;
}

export function TonConnectPanel(props: {
  session: Session;
  version: WalletVersion;
  onTxRequest: (req: DappTxRequest) => void;
}) {
  const [connections, setConnections] = useState<TonConnectConnection[]>([]);
  const [link, setLink] = useState('');
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // onTxRequest меняется на каждый рендер Dashboard — держим в ref, чтобы не пересоздавать SSE
  const onTxRequestRef = useRef(props.onTxRequest);
  onTxRequestRef.current = props.onTxRequest;
  const keyPairRef = useRef(props.session.keyPair);
  keyPairRef.current = props.session.keyPair;

  const reload = useCallback(() => {
    listTonConnectConnections()
      .then(setConnections)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  // Один SSE-поток на все подключения; события переживают перезагрузку через last_event_id
  useEffect(() => {
    if (connections.length === 0) return;
    let close: (() => void) | undefined;
    let cancelled = false;
    void loadTcLastEventId().then((lastEventId) => {
      if (cancelled) return;
      close = openBridgeEvents(
        connections.map((c) => c.session.publicKeyHex),
        lastEventId,
        (event) => {
          if (event.eventId) void saveTcLastEventId(event.eventId);
          const conn = connections.find((c) => c.dAppClientId === event.from);
          if (!conn) return;
          void handleBridgeMessage(conn, event.message);
        },
      );
    });
    return () => {
      cancelled = true;
      close?.();
    };
  }, [connections]);

  async function handleBridgeMessage(conn: TonConnectConnection, encrypted: string) {
    const reply = (json: string) =>
      postBridgeMessage(
        conn.session.publicKeyHex,
        conn.dAppClientId,
        encryptBridgeMessage(json, conn.dAppClientId, conn.session),
      );
    try {
      const json = decryptBridgeMessage(encrypted, conn.dAppClientId, conn.session);
      const parsed = parseAppRequest(json);
      if (parsed.kind === 'disconnect') {
        await deleteTonConnectConnection(conn.dAppClientId);
        reload();
        return;
      }
      if (parsed.kind === 'unknown') {
        await reply(
          JSON.stringify(
            buildSendTransactionError(parsed.id, 400, `Метод не поддерживается: ${parsed.method}`),
          ),
        );
        return;
      }
      if (parsed.request.network !== undefined && parsed.request.network !== '-3') {
        await reply(
          JSON.stringify(
            buildSendTransactionError(parsed.request.id, 300, 'Кошелёк работает только в testnet'),
          ),
        );
        return;
      }
      onTxRequestRef.current({ connection: conn, request: parsed.request, reply });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function startConnect() {
    setError(null);
    setBusy(true);
    try {
      const parsed = parseTonConnectLink(link);
      const manifest = await fetchManifest(parsed.manifestUrl);
      setPending({ link: parsed, manifest });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(p: PendingConnect) {
    setBusy(true);
    setError(null);
    try {
      const tcSession = createSession();
      const event = buildConnectEvent({
        id: Date.now(),
        keyPair: keyPairRef.current,
        version: props.version,
        network: NETWORK,
        items: p.link.items,
        domain: new URL(p.manifest.url).host,
        appName: APP_NAME,
        appVersion: APP_VERSION,
      });
      await postBridgeMessage(
        tcSession.publicKeyHex,
        p.link.dAppClientId,
        encryptBridgeMessage(JSON.stringify(event), p.link.dAppClientId, tcSession),
      );
      await saveTonConnectConnection({
        dAppClientId: p.link.dAppClientId,
        session: tcSession,
        manifestUrl: p.link.manifestUrl,
        appName: p.manifest.name,
        appUrl: p.manifest.url,
        createdAt: Date.now(),
      });
      setPending(null);
      setLink('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function decline(p: PendingConnect) {
    setPending(null);
    // connect_error шифруем одноразовой сессией — постоянная не нужна
    const tcSession = createSession();
    const event = buildConnectError(Date.now(), TONCONNECT_USER_DECLINED, 'Пользователь отклонил');
    await postBridgeMessage(
      tcSession.publicKeyHex,
      p.link.dAppClientId,
      encryptBridgeMessage(JSON.stringify(event), p.link.dAppClientId, tcSession),
    ).catch(() => {});
  }

  async function disconnect(conn: TonConnectConnection) {
    const event = { event: 'disconnect', id: Date.now(), payload: {} };
    await postBridgeMessage(
      conn.session.publicKeyHex,
      conn.dAppClientId,
      encryptBridgeMessage(JSON.stringify(event), conn.dAppClientId, conn.session),
    ).catch(() => {});
    await deleteTonConnectConnection(conn.dAppClientId);
    reload();
  }

  return (
    <fieldset>
      <legend>TON Connect</legend>
      {error && <p className="severity-danger">Ошибка: {error}</p>}

      {pending === null ? (
        <p>
          Ссылка из dApp (tc://…):{' '}
          <input
            style={{ width: '100%' }}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="tc://?v=2&id=…&r=…"
          />{' '}
          <button onClick={() => void startConnect()} disabled={busy || !link.trim()}>
            {busy ? 'Проверяем…' : 'Подключить'}
          </button>
        </p>
      ) : (
        <div style={{ border: '1px solid #ccc', padding: 8 }}>
          <p style={{ margin: '0 0 4px' }}>
            <b>{pending.manifest.name}</b> хочет подключиться к кошельку.
          </p>
          <p style={{ margin: '0 0 4px', wordBreak: 'break-all' }}>
            <small>Сайт: {pending.manifest.url}</small>
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <small>
              dApp увидит адрес и публичный ключ кошелька
              {pending.link.items.some((i) => i.name === 'ton_proof') &&
                ' и получит подпись владения адресом (ton_proof)'}
              . Отправка транзакций — только с твоим подтверждением.
            </small>
          </p>
          <button onClick={() => void approve(pending)} disabled={busy}>
            {busy ? 'Подключаем…' : 'Подключить'}
          </button>{' '}
          <button onClick={() => void decline(pending)} disabled={busy}>
            Отклонить
          </button>
        </div>
      )}

      {connections.map((c) => (
        <p key={c.dAppClientId} style={{ margin: '4px 0', wordBreak: 'break-all' }}>
          <b>{c.appName}</b> <small>{c.appUrl}</small>{' '}
          <button onClick={() => void disconnect(c)}>Отключить</button>
        </p>
      ))}
    </fieldset>
  );
}
