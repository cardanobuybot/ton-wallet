// «Включить уведомления» — Web Push через SW + ton_proof.
// Публичный VAPID-ключ приходит с сервера, приватный — только на api.
import { useCallback, useEffect, useState } from 'react';
import type { WalletAddress, WalletVersion } from '@ton-wallet/core';
import type { Session } from './session.ts';
import { signSocialProof } from './social.ts';
import {
  getVapidKey,
  subscribeToPush,
  unsubscribeFromPush,
  type WebPushSubscriptionJSON,
} from './api.ts';

/**
 * VAPID public key приходит как base64url — конвертируем в Uint8Array для
 * `PushManager.subscribe({applicationServerKey})`.
 */
function b64UrlToBytes(b64Url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64Url.length % 4)) % 4);
  const b64 = (b64Url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toJSON(sub: PushSubscription): WebPushSubscriptionJSON {
  const raw = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys.auth) {
    throw new Error('PushSubscription без ключей');
  }
  return {
    endpoint: raw.endpoint,
    keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
  };
}

export function NotificationsCard(props: {
  session: Session;
  address: WalletAddress;
  version: WalletVersion;
}) {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    supported ? Notification.permission : 'unsupported',
  );
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Читаем текущую подписку через SW-registration, если есть.
  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setEndpoint(sub?.endpoint ?? null);
    } catch {
      setEndpoint(null);
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supported) throw new Error('Браузер не поддерживает Web Push');
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') throw new Error('Разрешение на уведомления не выдано');
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await getVapidKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64UrlToBytes(publicKey),
      });
      const json = toJSON(sub);
      const auth = signSocialProof(
        props.session,
        props.address,
        props.version,
        `push-subscribe:${json.endpoint}`,
      );
      await subscribeToPush({ ...auth, subscription: json });
      setEndpoint(json.endpoint);
      setNotice('Уведомления включены');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supported) throw new Error('Браузер не поддерживает Web Push');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const auth = signSocialProof(
          props.session,
          props.address,
          props.version,
          `push-unsubscribe:${sub.endpoint}`,
        );
        await unsubscribeFromPush({ ...auth, endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setEndpoint(null);
      setNotice('Уведомления выключены');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Диагностика: показать нотификацию напрямую через SW registration, минуя
  // FCM/сервер. Если этот тест НЕ показывает уведомление на устройстве —
  // проблема системная (Chrome→Site→Notifications, Battery optimization,
  // Do-Not-Disturb, канал уведомлений Chrome отключён). Если этот тест
  // показывает, а реальные пуши нет — проблема доставки FCM→устройство
  // (маловероятно; чаще stale-endpoint или отключенный push для сайта).
  async function testShow() {
    setError(null);
    setNotice(null);
    try {
      if (!supported) throw new Error('Браузер не поддерживает уведомления');
      if (permission !== 'granted') {
        const perm = await Notification.requestPermission();
        setPermission(perm);
        if (perm !== 'granted') throw new Error('Разрешение не выдано');
      }
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('grampocket — тест', {
        body: 'Если видишь это — уведомления SW работают на устройстве.',
        tag: 'diag-test',
      });
      setNotice('Тест отправлен. Появилось уведомление в шторке?');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const active = endpoint !== null && permission === 'granted';

  return (
    <details>
      <summary>
        Уведомления
        {active && (
          <span className="pill pill-accent" style={{ marginLeft: 8 }}>
            вкл
          </span>
        )}
      </summary>
      <p style={{ marginTop: 8 }}>
        <small>
          Пуш-уведомления о поступлениях, отправках и активности подписок. Работают, даже
          когда вкладка закрыта.
        </small>
      </p>
      {!supported ? (
        <p className="severity-warn">Браузер не поддерживает Web Push.</p>
      ) : (
        <p>
          {active ? (
            <button type="button" onClick={() => void disable()} disabled={busy}>
              {busy ? 'Выключаем…' : 'Выключить уведомления'}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void enable()}
              disabled={busy}
            >
              {busy ? 'Включаем…' : 'Включить уведомления'}
            </button>
          )}
        </p>
      )}
      {supported && (
        <p style={{ marginTop: 4 }}>
          <button type="button" onClick={() => void testShow()}>
            Показать тестовое уведомление
          </button>
          <br />
          <small style={{ color: 'var(--muted)' }}>
            Без сервера — проверяет, что SW и системные разрешения на устройстве в порядке.
          </small>
        </p>
      )}
      {error && <p className="severity-danger">Ошибка: {error}</p>}
      {notice && <p className="severity-success">{notice}</p>}
    </details>
  );
}
