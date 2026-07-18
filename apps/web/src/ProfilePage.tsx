// Публичная страница профиля /u/<address> — читается без разблокировки кошелька.
// Данные тянутся через apps/api (публичный проки на toncenter). Никаких приватных
// операций: только просмотр, добавление в избранное (клиентская БД) и переход
// на форму отправки (навигация домой + prefill через sessionStorage).
import { useCallback, useEffect, useState } from 'react';
import { Address } from '@ton/core';
import {
  aggregateActivity,
  formatAddress,
  formatTokenAmount,
  formatTonAmount,
  parseTransactions,
  type ProfileActivity,
  type TxHistoryItem,
} from '@ton-wallet/core';
import {
  followAddress,
  getAccount,
  getAddressSocial,
  getJettons,
  getTransactions,
  listFollowing,
  unfollowAddress,
  type AddressSocial,
  type JettonBalance,
} from './api.ts';
import { navigate } from './router.ts';
import type { Session } from './session.ts';
import { signSocialProof } from './social.ts';
import { Avatar } from './ui/Avatar.tsx';
import {
  deleteFavorite,
  isFavorite,
  listAddressBook,
  saveFavorite,
} from './storage.ts';
import type { WalletAddress, WalletVersion } from '@ton-wallet/core';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const SEND_PREFILL_KEY = 'ton-wallet:sendPrefill';

const txHashHex = (base64: string): string =>
  Array.from(atob(base64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function shortAddr(friendly: string): string {
  return friendly.length > 12 ? `${friendly.slice(0, 6)}…${friendly.slice(-4)}` : friendly;
}

/**
 * Лояльный парсер: принимает raw (`0:<hex>`) и любую friendly-форму (mainnet+testnet флаг).
 * Профиль — публичный view, не хочется отказывать посетителям с mainnet-ссылкой.
 */
function parseAnyAddress(input: string): Address {
  const trimmed = input.trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(trimmed)) return Address.parseRaw(trimmed);
  return Address.parseFriendly(trimmed).address;
}

export interface ProfileViewer {
  session: Session;
  address: WalletAddress;
  version: WalletVersion;
}

export function ProfilePage(props: { addressInput: string; viewer?: ProfileViewer }) {
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [account, setAccount] = useState<{ balance: bigint; deployed: boolean } | null>(null);
  const [items, setItems] = useState<TxHistoryItem[]>([]);
  const [jettons, setJettons] = useState<JettonBalance[]>([]);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [fav, setFav] = useState<{ label: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [social, setSocial] = useState<AddressSocial | null>(null);
  const [socialErr, setSocialErr] = useState<string | null>(null);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    setAccount(null);
    setItems([]);
    setJettons([]);

    let addr: Address;
    try {
      addr = parseAnyAddress(props.addressInput);
    } catch {
      setError('Некорректный адрес в ссылке');
      setAddress(null);
      setLoading(false);
      return;
    }
    setAddress(addr);
    const raw = addr.toRawString();

    void listAddressBook().then((book) => {
      if (cancelled) return;
      setLabels(new Map(book.map((e) => [e.raw, e.label])));
    });
    void isFavorite(raw).then((yes) => {
      if (cancelled) return;
      setFav(yes ? { label: null } : null);
    });

    Promise.allSettled([
      getAccount(raw),
      getTransactions(raw),
      getJettons(raw),
    ]).then((results) => {
      if (cancelled) return;
      const [acc, txs, jets] = results;
      if (acc.status === 'fulfilled') {
        setAccount({ balance: BigInt(acc.value.balance), deployed: acc.value.deployed });
      }
      if (txs.status === 'fulfilled') {
        try {
          setItems(parseTransactions(txs.value.transactions, 'testnet'));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (jets.status === 'fulfilled') setJettons(jets.value.jettons);
      setLoading(false);
    });

    // Соц-данные (@name + счётчики) — отдельно от блокчейн-данных: если
    // apps/api без БД, эта ветка вернёт 503, а профиль всё равно откроется.
    setSocial(null);
    setSocialErr(null);
    setFollowing(null);
    getAddressSocial(raw)
      .then((s) => {
        if (!cancelled) setSocial(s);
      })
      .catch((e) => {
        if (!cancelled) setSocialErr(e instanceof Error ? e.message : String(e));
      });

    // Проверяем, подписан ли viewer на этот адрес — простой список без пагинации:
    // при первых сотнях подписок хватит; далее заведём /follows/is-following.
    const viewerRaw = props.viewer?.address.raw ?? null;
    if (viewerRaw && viewerRaw !== raw) {
      listFollowing(viewerRaw)
        .then((r) => {
          if (cancelled) return;
          setFollowing(r.items.some((i) => i.addressRaw === raw));
        })
        .catch(() => {
          if (!cancelled) setFollowing(null);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [props.addressInput, props.viewer?.address.raw]);

  const toggleFavorite = useCallback(async () => {
    if (!address) return;
    const raw = address.toRawString();
    if (fav) {
      await deleteFavorite(raw);
      setFav(null);
    } else {
      await saveFavorite({
        raw,
        friendly: formatAddress(address, 'testnet'),
        addedAt: Date.now(),
      });
      setFav({ label: null });
    }
  }, [address, fav]);

  const sendHere = useCallback(() => {
    if (!address) return;
    sessionStorage.setItem(SEND_PREFILL_KEY, formatAddress(address, 'testnet'));
    navigate({ name: 'home' });
  }, [address]);

  const toggleFollow = useCallback(async () => {
    if (!address || !props.viewer) return;
    const raw = address.toRawString();
    setFollowBusy(true);
    setSocialErr(null);
    try {
      const now = following;
      const body = {
        ...signSocialProof(
          props.viewer.session,
          props.viewer.address,
          props.viewer.version,
          now ? `unfollow:${raw}` : `follow:${raw}`,
        ),
        target: raw,
      };
      if (now) await unfollowAddress(body);
      else await followAddress(body);
      setFollowing(!now);
      const s = await getAddressSocial(raw);
      setSocial(s);
    } catch (e) {
      setSocialErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFollowBusy(false);
    }
  }, [address, following, props.viewer]);

  if (error) {
    return (
      <>
        <p className="severity-danger">Ошибка: {error}</p>
        <p>
          <button onClick={() => navigate({ name: 'home' })}>← В кошелёк</button>
        </p>
      </>
    );
  }

  if (!address) return <p>Загрузка…</p>;

  const friendly = formatAddress(address, 'testnet');
  const raw = address.toRawString();
  const label = labels.get(raw);
  const sinceUnix = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SECONDS;
  const activity: ProfileActivity = aggregateActivity(items, sinceUnix);
  const jettonByWallet = new Map(jettons.map((j) => [j.jettonWallet.toLowerCase(), j] as const));

  return (
    <>
      <p>
        <button onClick={() => navigate({ name: 'home' })}>← В кошелёк</button>
      </p>

      <fieldset>
        <legend>Профиль</legend>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar seed={raw} size={64} radius={20} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: '2px 0' }}>
              {social?.username ? (
                <>
                  @{social.username}{' '}
                  <small style={{ fontWeight: 'normal' }}>
                    ({label ?? shortAddr(friendly)})
                  </small>
                </>
              ) : (
                (label ?? shortAddr(friendly))
              )}
            </h2>
            <p style={{ margin: 0, wordBreak: 'break-all' }}>
              <small>{friendly}</small>
            </p>
          </div>
        </div>
        {social && (
          <p>
            <b>{social.followers}</b> подписчиков · подписан на{' '}
            <b>{social.following}</b>
          </p>
        )}
        <p>
          {account
            ? `Баланс: ${formatTonAmount(account.balance)} TON${account.deployed ? '' : ' (контракт не задеплоен)'}`
            : loading
              ? 'Загрузка баланса…'
              : 'Баланс недоступен'}
        </p>
        <p>
          <button onClick={() => void toggleFavorite()}>
            {fav ? '★ В избранном (убрать)' : '☆ В избранное'}
          </button>{' '}
          {props.viewer && props.viewer.address.raw !== raw && (
            <button onClick={() => void toggleFollow()} disabled={followBusy || following === null}>
              {followBusy
                ? '…'
                : following === null
                  ? 'Проверка…'
                  : following
                    ? 'Отписаться'
                    : 'Подписаться'}
            </button>
          )}{' '}
          <button onClick={sendHere}>Отправить сюда</button>{' '}
          <a
            href={`https://testnet.tonscan.org/address/${raw}`}
            target="_blank"
            rel="noreferrer"
          >
            tonscan
          </a>{' '}
          <button
            onClick={() => void navigator.clipboard.writeText(friendly).catch(() => {})}
          >
            Скопировать адрес
          </button>
        </p>
        {socialErr && (
          <p>
            <small className="severity-warn">
              Соц-данные недоступны: {socialErr}
            </small>
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Активность за 30 дней (по последним {items.length} транзакциям)</legend>
        {loading ? (
          <p>Загрузка…</p>
        ) : activity.txCount === 0 ? (
          <p>Активности в окне нет.</p>
        ) : (
          <>
            <p>
              Всего: <b>{activity.txCount}</b> (входящих {activity.txIn}, исходящих{' '}
              {activity.txOut}); джеттонов: <b>{activity.jettonTxCount}</b>; уникальных
              контрагентов: <b>{activity.uniqueCounterparties}</b>
            </p>
            <p className="severity-success">Получено TON: +{formatTonAmount(activity.tonIn)}</p>
            <p className="severity-danger">Отправлено TON: −{formatTonAmount(activity.tonOut)}</p>
            {activity.latestUtime !== null && (
              <p>
                <small>
                  Последняя учтённая транзакция:{' '}
                  {new Date(activity.latestUtime * 1000).toLocaleString()}
                </small>
              </p>
            )}
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Недавние действия</legend>
        {loading && items.length === 0 && <p>Загрузка…</p>}
        {!loading && items.length === 0 && <p>Транзакций пока нет.</p>}
        {items.map((t) => {
          const known = t.jetton
            ? jettonByWallet.get(t.jetton.jettonWallet.toLowerCase())
            : undefined;
          return (
            <p key={`${t.lt}:${t.hash}`} style={{ margin: '4px 0' }}>
              <span className={t.direction === 'in' ? 'severity-success' : 'severity-danger'} style={{ fontWeight: 600 }}>
                {t.direction === 'in' ? '+' : '−'}
                {t.jetton
                  ? known
                    ? `${formatTokenAmount(t.jetton.amount, known.decimals)} ${known.symbol ?? known.name ?? 'JETTON'}`
                    : `${t.jetton.amount} ед. джеттона`
                  : `${formatTonAmount(t.amount)} TON`}
              </span>{' '}
              <small>
                {new Date(t.utime * 1000).toLocaleString()}{' '}
                <a
                  href={`https://testnet.tonscan.org/tx/${txHashHex(t.hash)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx
                </a>
              </small>
              {t.counterparty && (
                <>
                  <br />
                  <small style={{ wordBreak: 'break-all' }}>
                    {t.direction === 'in' ? 'от' : 'кому'}:{' '}
                    {labels.has(t.counterparty.raw) && (
                      <b className="severity-success">«{labels.get(t.counterparty.raw)}» </b>
                    )}
                    <a href={`#/u/${encodeURIComponent(t.counterparty.raw)}`}>
                      {t.counterparty.friendly}
                    </a>
                  </small>
                </>
              )}
              {t.comment && (
                <>
                  <br />
                  <small>«{t.comment}»</small>
                </>
              )}
            </p>
          );
        })}
      </fieldset>
    </>
  );
}

/** Считать заготовку получателя (для App.tsx после возврата из ProfilePage). */
export function consumeSendPrefill(): string | null {
  const v = sessionStorage.getItem(SEND_PREFILL_KEY);
  if (v !== null) sessionStorage.removeItem(SEND_PREFILL_KEY);
  return v;
}
