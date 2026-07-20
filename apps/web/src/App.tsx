import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeRecipient,
  applyWarnings,
  buildJettonTransferBody,
  buildSendTransactionError,
  buildSendTransactionSuccess,
  buildSimulationReport,
  createRawTransfer,
  createTransfer,
  TONCONNECT_USER_DECLINED,
  detectFakeToken,
  formatTokenAmount,
  JETTON_TRANSFER_ATTACHED_TON,
  parseTokenAmount,
  decryptMnemonic,
  encryptMnemonic,
  formatAddress,
  formatTonAmount,
  generateMnemonic,
  getWalletAddress,
  IMPORTABLE_VERSIONS,
  mnemonicToKeyPair,
  parseRecipientAddress,
  parseTonAmount,
  resolveBounce,
  validateMnemonic,
  parseTransactions,
  type Severity,
  type SimulationReport,
  type SimulationWarning,
  type TxCounterparty,
  type TxHistoryItem,
  type WalletAddress,
  type WalletVersion,
} from '@ton-wallet/core';
import qrcode from 'qrcode-generator';
import {
  emulate,
  estimateFee,
  getAccount,
  getAddressIntel,
  getJettons,
  getTransactions,
  sendBoc,
  type AddressIntel,
  type JettonBalance,
} from './api.ts';
import { AUTO_LOCK_MS, zeroizeSession, type Session } from './session.ts';
import { TonConnectPanel, type DappTxRequest } from './TonConnectPanel.tsx';
import { ProfilePage, consumeSendPrefill } from './ProfilePage.tsx';
import { profileHref, useRoute } from './router.ts';
import { AddressChip } from './ui/AddressChip.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { GramLogo } from './ui/GramLogo.tsx';
import { WalletLogo } from './ui/WalletLogo.tsx';
import { NotificationsCard } from './NotificationsCard.tsx';
import { BottomSheet } from './ui/BottomSheet.tsx';
import { useToast } from './ui/Toast.tsx';
import { IconLock, IconReceive, IconRefresh, IconSend } from './ui/Icons.tsx';
import {
  deleteAddressBookEntry,
  deleteEnvelope,
  deleteFavorite,
  listAddressBook,
  listFavorites,
  isStoragePersisted,
  loadEnvelope,
  loadWalletVersion,
  requestPersistentStorage,
  saveAddressBookEntry,
  saveEnvelope,
  saveFavorite,
  saveWalletVersion,
  type AddressBookEntry,
  type FavoriteAddress,
} from './storage.ts';

const NETWORK = 'testnet' as const;

type Screen =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'show-mnemonic'; mnemonic: string[] }
  | { name: 'verify-mnemonic'; mnemonic: string[] }
  | { name: 'import' }
  | { name: 'choose-version'; mnemonic: string[] }
  | { name: 'password'; mnemonic: string[]; version: WalletVersion }
  | { name: 'locked' }
  | { name: 'wallet'; session: Session; address: WalletAddress; version: WalletVersion };

interface PendingSend {
  /** Прикладываемые к сообщению TON (для джеттона — газ 0.05 TON) */
  amount: bigint;
  /** Человекочитаемая сумма перевода (для джеттона — в его единицах) */
  displayAmount: string;
  comment: string;
  fee: bigint;
  boc: string;
  seqnoBefore: number;
  report: SimulationReport;
  recipient: TxCounterparty;
  /** null — /address-intel недоступен (не блокирует отправку) */
  intel: AddressIntel | null;
  label?: string;
  /** Запрос пришёл из TON Connect: после отправки/отмены отвечаем dApp через мост */
  dapp?: DappTxRequest;
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();
  // null — ещё не знаем; false — браузер может выселить IndexedDB при нехватке места
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const lock = useCallback(() => {
    if (sessionRef.current) {
      zeroizeSession(sessionRef.current);
      sessionRef.current = null;
    }
    setScreen({ name: 'locked' });
  }, []);

  useEffect(() => {
    loadEnvelope()
      .then((env) => setScreen(env ? { name: 'locked' } : { name: 'setup' }))
      .catch((e) => setError(String(e)));
    void isStoragePersisted().then(setPersisted);
  }, []);

  // Автолок: 5 минут без активности пользователя → занулить ключи.
  useEffect(() => {
    if (screen.name !== 'wallet') return;
    let timer = setTimeout(lock, AUTO_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, AUTO_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown'] as const;
    events.forEach((e) => window.addEventListener(e, reset));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [screen.name, lock]);

  async function openWallet(mnemonic: string[], version: WalletVersion) {
    const keyPair = await mnemonicToKeyPair(mnemonic);
    const session: Session = { keyPair, mnemonic };
    sessionRef.current = session;
    const address = getWalletAddress(keyPair, { version, network: NETWORK });
    setScreen({ name: 'wallet', session, address, version });
  }

  async function guard<T>(fn: () => Promise<T>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <p className="dev-banner">
        <b>DEV ONLY — testnet.</b> Не использовать с реальными средствами.
      </p>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
        <WalletLogo size={36} />
        grampocket
      </h1>
      {error && <p className="severity-danger">Ошибка: {error}</p>}

      {route.name === 'profile' && (
        <ProfilePage
          addressInput={route.address}
          {...(screen.name === 'wallet'
            ? {
                viewer: {
                  session: screen.session,
                  address: screen.address,
                  version: screen.version,
                },
              }
            : {})}
        />
      )}

      {route.name === 'home' && screen.name === 'loading' && <p>Загрузка…</p>}

      {route.name === 'home' && screen.name === 'setup' && (
        <>
          <button onClick={() => guard(async () => {
            setScreen({ name: 'show-mnemonic', mnemonic: await generateMnemonic() });
          })}>
            Создать новый кошелёк
          </button>{' '}
          <button onClick={() => setScreen({ name: 'import' })}>Импортировать (24 слова)</button>
        </>
      )}

      {route.name === 'home' && screen.name === 'show-mnemonic' && (
        <>
          <h2>Запиши мнемонику</h2>
          <ol style={{ columns: 2 }}>
            {screen.mnemonic.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
          <button onClick={() => setScreen({ name: 'verify-mnemonic', mnemonic: screen.mnemonic })}>
            Я записал — дальше
          </button>
        </>
      )}

      {route.name === 'home' && screen.name === 'verify-mnemonic' && (
        <MnemonicQuiz
          mnemonic={screen.mnemonic}
          onPass={() => setScreen({ name: 'password', mnemonic: screen.mnemonic, version: 'v5r1' })}
          onBack={() => setScreen({ name: 'show-mnemonic', mnemonic: screen.mnemonic })}
        />
      )}

      {route.name === 'home' && screen.name === 'import' && (
        <ImportForm
          onSubmit={(words) =>
            guard(async () => {
              if (!(await validateMnemonic(words))) {
                throw new Error('Невалидная мнемоника (нужны 24 слова TON-схемы)');
              }
              setScreen({ name: 'choose-version', mnemonic: words });
            })
          }
          onBack={() => setScreen({ name: 'setup' })}
        />
      )}

      {route.name === 'home' && screen.name === 'choose-version' && (
        <VersionPicker
          mnemonic={screen.mnemonic}
          onPick={(version) => setScreen({ name: 'password', mnemonic: screen.mnemonic, version })}
          onBack={() => setScreen({ name: 'import' })}
        />
      )}

      {route.name === 'home' && screen.name === 'password' && (
        <PasswordForm
          label="Задай пароль (мин. 8 символов) — им шифруется мнемоника на этом устройстве"
          onSubmit={(password) =>
            guard(async () => {
              if (password.length < 8) throw new Error('Пароль короче 8 символов');
              await saveEnvelope(await encryptMnemonic(screen.mnemonic, password));
              await saveWalletVersion(screen.version);
              setPersisted(await requestPersistentStorage());
              await openWallet(screen.mnemonic, screen.version);
            })
          }
        />
      )}

      {route.name === 'home' && screen.name === 'locked' && (
        <>
          <PasswordForm
            label="Введи пароль"
            submitText="Разблокировать"
            onSubmit={(password) =>
              guard(async () => {
                const envelope = await loadEnvelope();
                if (!envelope) {
                  setScreen({ name: 'setup' });
                  return;
                }
                const stored = await loadWalletVersion();
                const version = (IMPORTABLE_VERSIONS as readonly string[]).includes(stored ?? '')
                  ? (stored as WalletVersion)
                  : 'v5r1';
                await openWallet(await decryptMnemonic(envelope, password), version);
              })
            }
          />
          <p>
            <button
              onClick={() =>
                guard(async () => {
                  if (confirm('Удалить кошелёк с устройства? Без мнемоники доступ не вернуть.')) {
                    await deleteEnvelope();
                    setScreen({ name: 'setup' });
                  }
                })
              }
            >
              Удалить кошелёк с устройства
            </button>
          </p>
        </>
      )}

      {route.name === 'home' && screen.name === 'wallet' && persisted === false && (
        <p className="severity-warn">
          Браузер может удалить локальные данные кошелька при нехватке места.{' '}
          <button onClick={() => void requestPersistentStorage().then(setPersisted)}>
            Защитить хранилище
          </button>{' '}
          <small>(сид-фраза — единственный настоящий бэкап)</small>
        </p>
      )}
      {route.name === 'home' && screen.name === 'wallet' && (
        <Dashboard
          session={screen.session}
          address={screen.address}
          version={screen.version}
          onLock={lock}
        />
      )}
    </main>
  );
}

function ImportForm(props: { onSubmit: (words: string[]) => void; onBack: () => void }) {
  const [text, setText] = useState('');
  return (
    <>
      <h2>Импорт</h2>
      <textarea
        rows={4}
        style={{ width: '100%' }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="24 слова через пробел"
      />
      <p>
        <button onClick={() => props.onSubmit(text.trim().toLowerCase().split(/\s+/))}>
          Импортировать
        </button>{' '}
        <button onClick={props.onBack}>Назад</button>
      </p>
    </>
  );
}

// Три случайные позиции для проверки «действительно записал»
function pickQuizPositions(count: number): number[] {
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  const positions = new Set<number>();
  for (const v of buf) {
    if (positions.size >= 3) break;
    positions.add(v % count);
  }
  // Uint32Array(8) практически всегда даёт 3 разных; добираем детерминированно
  for (let i = 0; positions.size < 3; i++) positions.add(i);
  return [...positions].sort((a, b) => a - b);
}

function MnemonicQuiz(props: { mnemonic: string[]; onPass: () => void; onBack: () => void }) {
  const [positions] = useState(() => pickQuizPositions(props.mnemonic.length));
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [wrong, setWrong] = useState(false);
  return (
    <>
      <h2>Проверка мнемоники</h2>
      <p>Введи слова с указанными номерами — так мы убедимся, что ты их записал.</p>
      {positions.map((pos, i) => (
        <p key={pos}>
          Слово №{pos + 1}:{' '}
          <input
            value={answers[i]}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(e) => {
              const next = [...answers];
              next[i] = e.target.value;
              setAnswers(next);
            }}
          />
        </p>
      ))}
      {wrong && (
        <p className="severity-danger">Есть ошибки — сверься с записанной мнемоникой.</p>
      )}
      <p>
        <button
          onClick={() => {
            const ok = positions.every(
              (pos, i) => answers[i]!.trim().toLowerCase() === props.mnemonic[pos],
            );
            if (ok) props.onPass();
            else setWrong(true);
          }}
        >
          Проверить
        </button>{' '}
        <button onClick={props.onBack}>Назад к словам</button>
      </p>
    </>
  );
}

function VersionPicker(props: {
  mnemonic: string[];
  onPick: (version: WalletVersion) => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<Array<{
    version: WalletVersion;
    address: WalletAddress;
    balance: bigint | null;
    deployed: boolean;
  }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keyPair = await mnemonicToKeyPair(props.mnemonic);
      const result = await Promise.all(
        IMPORTABLE_VERSIONS.map(async (version) => {
          const address = getWalletAddress(keyPair, { version, network: NETWORK });
          const info = await getAccount(address.nonBounceable).catch(() => null);
          return {
            version,
            address,
            balance: info ? BigInt(info.balance) : null,
            deployed: info?.deployed ?? false,
          };
        }),
      );
      if (!cancelled) setRows(result);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.mnemonic]);

  return (
    <>
      <h2>Выбери версию кошелька</h2>
      <p>
        Одна мнемоника даёт разные адреса в разных версиях контракта. Выбери ту, где твои
        средства (обычно — где баланс не нулевой).
      </p>
      {rows === null && <p>Смотрим балансы…</p>}
      {rows?.map((r) => (
        <p key={r.version} style={{ wordBreak: 'break-all' }}>
          <button onClick={() => props.onPick(r.version)}>Выбрать {r.version}</button>{' '}
          <b>
            {r.balance === null ? 'баланс недоступен' : `${formatTonAmount(r.balance)} TON`}
          </b>
          {r.deployed && ' · задеплоен'}
          <br />
          <small>{r.address.nonBounceable}</small>
        </p>
      ))}
      <p>
        <button onClick={props.onBack}>Назад</button>
      </p>
    </>
  );
}

function PasswordForm(props: {
  label: string;
  submitText?: string;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(password);
      }}
    >
      <fieldset>
        <legend>{props.label}</legend>
        <p style={{ margin: '0 0 10px' }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{ width: '100%' }}
          />
        </p>
        <button type="submit" className="btn-primary" style={{ width: '100%' }}>
          {props.submitText ?? 'Сохранить'}
        </button>
      </fieldset>
    </form>
  );
}

function QrCode(props: { data: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(props.data);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={props.size ?? 200}
      height={props.size ?? 200}
      role="img"
      aria-label="QR-код адреса"
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

const SEVERITY_COLOR: Record<Severity, string> = {
  info: '#666',
  warn: '#b36b00',
  danger: '#b00',
};

function SimulationView(props: { report: SimulationReport }) {
  const { report } = props;
  const rejected = report.warnings.some((w) => w.code === 'EMULATION_REJECTED');
  return (
    <div style={{ border: '1px solid #ccc', padding: 8, margin: '8px 0' }}>
      <p style={{ margin: '0 0 4px' }}>
        <b>Симуляция:</b>{' '}
        {report.emulated
          ? 'выполнена (tonapi emulate)'
          : rejected
            ? 'эмулятор отверг транзакцию'
            : 'недоступна — оценка по dry-run'}
      </p>
      <p style={{ margin: '0 0 4px' }}>
        Изменение баланса: <b>{formatTonAmount(report.balanceChange)} GRAM</b> (комиссии ~
        {formatTonAmount(report.fees)} GRAM)
      </p>
      {report.actions.map((a, i) => (
        <p key={i} style={{ margin: '0 0 4px' }}>
          {a.type}: {a.description}
          {a.amount !== undefined && <> — {formatTonAmount(a.amount)} GRAM</>}
        </p>
      ))}
      {report.warnings.map((w) => (
        <p key={w.code} style={{ margin: '0 0 4px', color: SEVERITY_COLOR[w.severity] }}>
          [{w.severity}] {w.message}
        </p>
      ))}
      {report.verdict === 'danger' && (
        <p style={{ margin: 0, color: SEVERITY_COLOR.danger }}>
          <b>Отправка заблокирована: симуляция нашла критичную проблему.</b>
        </p>
      )}
    </div>
  );
}

function RecipientCard(props: { intel: AddressIntel | null; label?: string }) {
  const { intel, label } = props;
  const days =
    intel?.firstSeen != null
      ? Math.floor((Date.now() / 1000 - intel.firstSeen) / 86400)
      : null;
  return (
    <div style={{ border: '1px solid #ccc', padding: 8, margin: '8px 0' }}>
      <p style={{ margin: '0 0 4px' }}>
        <b>Получатель:</b>{' '}
        {label !== undefined ? (
          <span className="severity-success">«{label}» (из адресной книги)</span>
        ) : (
          'нет в адресной книге'
        )}
      </p>
      {intel === null ? (
        <p style={{ margin: 0, color: '#666' }}>Досье адреса недоступно.</p>
      ) : (
        <p style={{ margin: 0 }}>
          {intel.firstSeen != null ? (
            <>
              Первая транзакция: {new Date(intel.firstSeen * 1000).toLocaleDateString()}
              {days !== null && <> ({days} дн. назад{intel.txCountCapped ? ' или раньше' : ''})</>}
            </>
          ) : (
            'Транзакций у адреса не видно'
          )}
          {' · '}транзакций: {intel.txCount}
          {intel.txCountCapped ? '+' : ''}
          {' · '}
          {intel.deployed ? 'задеплоен' : 'не задеплоен'}
        </p>
      )}
    </div>
  );
}

function AddressBook(props: { book: AddressBookEntry[]; onChange: () => void }) {
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <details>
      <summary>
        Адресная книга
        {props.book.length > 0 && (
          <span className="pill" style={{ marginLeft: 8 }}>{props.book.length}</span>
        )}
      </summary>
      {error && <p className="severity-danger">Ошибка: {error}</p>}
      {props.book.map((e) => (
        <p key={e.raw} style={{ wordBreak: 'break-all', margin: '4px 0' }}>
          <b>{e.label}</b> — <small>{e.friendly}</small>{' '}
          <button
            onClick={() => {
              deleteAddressBookEntry(e.raw).then(props.onChange).catch((err) =>
                setError(String(err)),
              );
            }}
          >
            Удалить
          </button>
        </p>
      ))}
      <p>
        Адрес:{' '}
        <input style={{ width: '100%' }} value={addr} onChange={(e) => setAddr(e.target.value)} />
      </p>
      <p>
        Метка: <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />{' '}
        <button
          onClick={() => {
            setError(null);
            try {
              if (!label.trim()) throw new Error('Пустая метка');
              const parsed = parseRecipientAddress(addr, NETWORK);
              const entry: AddressBookEntry = {
                raw: parsed.address.toRawString(),
                friendly: formatAddress(parsed.address, NETWORK),
                label: label.trim(),
              };
              saveAddressBookEntry(entry)
                .then(() => {
                  setAddr('');
                  setLabel('');
                  props.onChange();
                })
                .catch((err) => setError(String(err)));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Сохранить
        </button>
      </p>
    </details>
  );
}

function Favorites(props: { items: FavoriteAddress[]; onChange: () => void }) {
  return (
    <details>
      <summary>
        Избранное
        {props.items.length > 0 && (
          <span className="pill" style={{ marginLeft: 8 }}>{props.items.length}</span>
        )}
      </summary>
      {props.items.length === 0 && (
        <p>
          <small>Добавь адрес со страницы профиля или из подтверждения перевода.</small>
        </p>
      )}
      {props.items.map((f) => (
        <div
          key={f.raw}
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            margin: '6px 0',
          }}
        >
          <Avatar seed={f.raw} size={32} radius={10} />
          <a
            href={profileHref(f.raw)}
            style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}
          >
            {f.label ?? f.friendly}
          </a>
          <button
            onClick={() => {
              deleteFavorite(f.raw).then(props.onChange).catch(() => {});
            }}
          >
            Убрать
          </button>
        </div>
      ))}
    </details>
  );
}

const txHashHex = (base64: string): string =>
  Array.from(atob(base64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function History(props: {
  address: WalletAddress;
  reloadKey: number;
  labels: ReadonlyMap<string, string>;
  jettons: JettonBalance[];
}) {
  // raw-адрес джеттон-кошелька → символ и decimals для человеческого отображения
  const jettonByWallet = new Map(
    props.jettons.map((j) => [j.jettonWallet.toLowerCase(), j] as const),
  );
  const [items, setItems] = useState<TxHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(
    async (cursor?: { lt: string; hash: string }) => {
      setLoading(true);
      setError(null);
      try {
        const { transactions } = await getTransactions(props.address.nonBounceable, cursor);
        const page = parseTransactions(transactions, 'testnet');
        // Курсорная страница включает саму курсорную транзакцию — отбрасываем её
        const fresh = cursor ? page.filter((t) => t.lt !== cursor.lt) : page;
        setItems((prev) => (cursor ? [...prev, ...fresh] : page));
        if (fresh.length === 0) setExhausted(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [props.address.nonBounceable],
  );

  useEffect(() => {
    setExhausted(false);
    load().catch(() => {});
    // reloadKey (seqno) меняется после отправки — история перезагружается
  }, [load, props.reloadKey]);

  const last = items[items.length - 1];

  return (
    <section className="card">
      <h3 className="card-title">История</h3>
      {error && <p className="severity-danger">Ошибка: {error}</p>}
      {items.length === 0 && !loading && !error && <p style={{ color: 'var(--muted)' }}>Транзакций пока нет.</p>}
      {items.map((t) => {
        const known = t.jetton ? jettonByWallet.get(t.jetton.jettonWallet.toLowerCase()) : undefined;
        const amountText = t.jetton
          ? known
            ? `${formatTokenAmount(t.jetton.amount, known.decimals)} ${known.symbol ?? known.name ?? 'JETTON'}`
            : `${t.jetton.amount} ед.`
          : `${formatTonAmount(t.amount)} GRAM`;
        return (
          <div key={`${t.lt}:${t.hash}`} className="tx-row">
            {t.counterparty ? (
              <Avatar seed={t.counterparty.raw} size={32} radius={10} />
            ) : (
              <div className={`tx-dir ${t.direction}`}>{t.direction === 'in' ? '↓' : '↑'}</div>
            )}
            <div className="tx-main">
              <div className="tx-verb">
                {t.direction === 'in' ? 'Получено' : 'Отправлено'}
              </div>
              {t.counterparty && (
                <div className="tx-cp">
                  {props.labels.has(t.counterparty.raw) ? (
                    <b className="severity-success">«{props.labels.get(t.counterparty.raw)}»</b>
                  ) : (
                    <a href={profileHref(t.counterparty.raw)}>
                      {t.counterparty.friendly.slice(0, 6)}…{t.counterparty.friendly.slice(-4)}
                    </a>
                  )}
                </div>
              )}
              {t.comment && <span className="tx-comment">«{t.comment}»</span>}
            </div>
            <div className="tx-right">
              <div className={`tx-amt ${t.direction}`}>
                {t.direction === 'in' ? '+' : '−'}
                {amountText}
              </div>
              <div className="tx-time">
                {new Date(t.utime * 1000).toLocaleString()}{' '}
                <a
                  href={`https://testnet.tonscan.org/tx/${txHashHex(t.hash)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx
                </a>
              </div>
            </div>
          </div>
        );
      })}
      {loading && <p style={{ color: 'var(--muted)' }}>Загрузка…</p>}
      {!loading && last && !exhausted && (
        <button
          type="button"
          onClick={() => load({ lt: last.lt, hash: last.hash })}
          style={{ marginTop: 8 }}
        >
          Ещё
        </button>
      )}
    </section>
  );
}

type SendState =
  | { step: 'idle' }
  | { step: 'preparing' }
  | { step: 'confirm'; pending: PendingSend }
  | { step: 'sending'; pending: PendingSend }
  | { step: 'waiting'; pending: PendingSend }
  | { step: 'done' };

function Dashboard(props: {
  session: Session;
  address: WalletAddress;
  version: WalletVersion;
  onLock: () => void;
}) {
  const { session, address, version } = props;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [seqno, setSeqno] = useState(0);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [send, setSend] = useState<SendState>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [book, setBook] = useState<AddressBookEntry[]>([]);
  const [jettons, setJettons] = useState<JettonBalance[]>([]);
  // 'TON' либо raw-адрес jetton master выбранного джеттона
  const [asset, setAsset] = useState('TON');

  useEffect(() => {
    getJettons(address.nonBounceable)
      .then((r) => setJettons(r.jettons))
      .catch(() => {});
  }, [address.nonBounceable, seqno]);

  const reloadBook = useCallback(() => {
    listAddressBook()
      .then(setBook)
      .catch(() => {});
  }, []);
  useEffect(reloadBook, [reloadBook]);

  const [favorites, setFavorites] = useState<FavoriteAddress[]>([]);
  const reloadFavorites = useCallback(() => {
    listFavorites()
      .then(setFavorites)
      .catch(() => {});
  }, []);
  useEffect(reloadFavorites, [reloadFavorites]);

  // «Отправить сюда» с профиля кладёт адрес в sessionStorage → подхватываем сюда.
  useEffect(() => {
    const prefill = consumeSendPrefill();
    if (prefill) setTo(prefill);
  }, []);

  const refresh = useCallback(async () => {
    const info = await getAccount(address.nonBounceable);
    setBalance(BigInt(info.balance));
    setSeqno(info.seqno);
    return info;
  }, [address.nonBounceable]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  async function prepare() {
    setError(null);
    setSend({ step: 'preparing' });
    try {
      const recipient = parseRecipientAddress(to, NETWORK);
      const selected = asset === 'TON' ? undefined : jettons.find((j) => j.jettonMaster === asset);
      if (asset !== 'TON' && !selected) throw new Error('Джеттон не найден');
      const nano = selected ? parseTokenAmount(amount, selected.decimals) : parseTonAmount(amount);
      const recipientCp: TxCounterparty = {
        raw: recipient.address.toRawString(),
        friendly: formatAddress(recipient.address, NETWORK),
      };
      // Досье и история — для анти-скам проверок; их сбой не блокирует поток
      const [own, recipientInfo, intel, ownHistory] = await Promise.all([
        refresh(),
        getAccount(recipient.address.toRawString()),
        getAddressIntel(recipientCp.raw).catch(() => null),
        getTransactions(address.nonBounceable)
          .then((r) => parseTransactions(r.transactions, NETWORK))
          .catch(() => [] as TxHistoryItem[]),
      ]);
      const label = book.find((e) => e.raw === recipientCp.raw)?.label;
      if (selected && nano > BigInt(selected.balance)) {
        throw new Error('Недостаточно джеттонов');
      }
      // Джеттон: сообщение идёт на СВОЙ jetton wallet (он задеплоен, bounce=true),
      // прикладываем 0.05 TON газа; получатель — внутри тела TEP-74.
      const attached = selected ? JETTON_TRANSFER_ATTACHED_TON : nano;
      // Перевод на кошелёк: bounce=false; для незадеплоенного — принудительно false.
      const bounce = selected ? true : resolveBounce(false, recipientInfo.deployed);
      const transfer = createTransfer({
        keyPair: session.keyPair,
        version,
        network: NETWORK,
        seqno: own.seqno,
        to: selected
          ? parseRecipientAddress(selected.jettonWallet, NETWORK).address
          : recipient.address,
        amount: attached,
        bounce,
        ...(selected
          ? {
              body: buildJettonTransferBody({
                amount: nano,
                to: recipient.address,
                responseTo: parseRecipientAddress(address.nonBounceable, NETWORK).address,
                ...(comment ? { comment } : {}),
              }),
            }
          : comment
            ? { comment }
            : {}),
      });
      const fee = await estimateFee({
        address: address.nonBounceable,
        body: transfer.bodyBocBase64,
        ...(transfer.initCodeBocBase64
          ? { initCode: transfer.initCodeBocBase64, initData: transfer.initDataBocBase64! }
          : {}),
      });
      // Симуляция перед подписью. Сбой сети/прокси — не ошибка: fallback-отчёт.
      const emu = await emulate(transfer.bocBase64, address.raw).catch(() => null);
      // Эмулятор видит меньше денег, чем toncenter → его индексер отстал,
      // отказ недостоверен (EMULATOR_STALE вместо блокировки).
      const emulatorOutdated =
        emu?.rejected === true &&
        emu.emulatorBalance !== undefined &&
        BigInt(emu.emulatorBalance) < BigInt(own.balance);
      const report = applyWarnings(
        buildSimulationReport({
          event: emu?.ok ? (emu.event ?? null) : null,
          ...(emu?.rejected && emu.error ? { rejectionError: emu.error } : {}),
          emulatorOutdated,
          ownAddressRaw: address.raw,
          balance: BigInt(own.balance),
          enteredAmount: attached,
          recipientDeployed: recipientInfo.deployed,
          fallbackFee: BigInt(fee.totalFee),
          jettonTransfer: selected !== undefined,
        }),
        // Анти-скам по локальной истории: address poisoning (danger) блокирует
        [
          ...analyzeRecipient({
            recipient: recipientCp,
            history: ownHistory,
            recipientLabeled: label !== undefined,
          }),
          ...(selected
            ? [
                detectFakeToken({
                  symbol: selected.symbol,
                  name: selected.name,
                  masterRaw: selected.jettonMaster,
                  network: NETWORK,
                }),
              ].filter((w): w is SimulationWarning => w !== null)
            : []),
        ],
      );
      setSend({
        step: 'confirm',
        pending: {
          amount: attached,
          displayAmount: selected
            ? `${formatTokenAmount(nano, selected.decimals)} ${selected.symbol ?? selected.name ?? 'JETTON'} (+ ${formatTonAmount(attached)} TON газ)`
            : `${formatTonAmount(nano)} GRAM`,
          comment,
          fee: BigInt(fee.totalFee),
          boc: transfer.bocBase64,
          seqnoBefore: own.seqno,
          report,
          recipient: recipientCp,
          intel,
          ...(label !== undefined ? { label } : {}),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSend({ step: 'idle' });
    }
  }

  // dApp может прислать friendly-адрес с mainnet-флагом (частая практика) — парсим лояльно
  function parseDappAddress(input: string) {
    try {
      return parseRecipientAddress(input, NETWORK).address;
    } catch {
      return parseRecipientAddress(input, 'mainnet').address;
    }
  }

  async function handleDappRequest(req: DappTxRequest) {
    const declined = (message: string) =>
      req
        .reply(
          JSON.stringify(
            buildSendTransactionError(req.request.id, TONCONNECT_USER_DECLINED, message),
          ),
        )
        .catch(() => {});
    if (send.step !== 'idle' && send.step !== 'done') {
      void declined('Кошелёк занят другой операцией');
      return;
    }
    setError(null);
    setSend({ step: 'preparing' });
    try {
      const msgs = req.request.messages;
      const total = msgs.reduce((sum, m) => sum + m.amount, 0n);
      const firstAddr = parseDappAddress(msgs[0]!.address);
      const recipientCp: TxCounterparty = {
        raw: firstAddr.toRawString(),
        friendly: formatAddress(firstAddr, NETWORK),
      };
      const [own, recipientInfo, intel, ownHistory] = await Promise.all([
        refresh(),
        getAccount(recipientCp.raw).catch(() => null),
        getAddressIntel(recipientCp.raw).catch(() => null),
        getTransactions(address.nonBounceable)
          .then((r) => parseTransactions(r.transactions, NETWORK))
          .catch(() => [] as TxHistoryItem[]),
      ]);
      const transfer = createRawTransfer({
        keyPair: session.keyPair,
        version,
        network: NETWORK,
        seqno: own.seqno,
        messages: msgs,
        ...(req.request.validUntil !== undefined ? { validUntil: req.request.validUntil } : {}),
      });
      const fee = await estimateFee({
        address: address.nonBounceable,
        body: transfer.bodyBocBase64,
        ...(transfer.initCodeBocBase64
          ? { initCode: transfer.initCodeBocBase64, initData: transfer.initDataBocBase64! }
          : {}),
      });
      const emu = await emulate(transfer.bocBase64, address.raw).catch(() => null);
      const emulatorOutdated =
        emu?.rejected === true &&
        emu.emulatorBalance !== undefined &&
        BigInt(emu.emulatorBalance) < BigInt(own.balance);
      const label = book.find((e) => e.raw === recipientCp.raw)?.label;
      const report = applyWarnings(
        buildSimulationReport({
          event: emu?.ok ? (emu.event ?? null) : null,
          ...(emu?.rejected && emu.error ? { rejectionError: emu.error } : {}),
          emulatorOutdated,
          ownAddressRaw: address.raw,
          balance: BigInt(own.balance),
          enteredAmount: total,
          recipientDeployed: recipientInfo?.deployed ?? false,
          fallbackFee: BigInt(fee.totalFee),
        }),
        analyzeRecipient({
          recipient: recipientCp,
          history: ownHistory,
          recipientLabeled: label !== undefined,
        }),
      );
      setSend({
        step: 'confirm',
        pending: {
          amount: total,
          displayAmount: `${formatTonAmount(total)} GRAM (сообщений: ${msgs.length})`,
          comment: '',
          fee: BigInt(fee.totalFee),
          boc: transfer.bocBase64,
          seqnoBefore: own.seqno,
          report,
          recipient: recipientCp,
          intel,
          ...(label !== undefined ? { label } : {}),
          dapp: req,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSend({ step: 'idle' });
      void declined('Кошелёк не смог обработать запрос');
    }
  }

  async function confirmSend(pending: PendingSend) {
    setError(null);
    setSend({ step: 'sending', pending });
    try {
      await sendBoc(pending.boc);
      // dApp ждёт подписанный BOC сразу после отправки, не после подтверждения сетью
      if (pending.dapp) {
        void pending.dapp
          .reply(JSON.stringify(buildSendTransactionSuccess(pending.dapp.request.id, pending.boc)))
          .catch(() => {});
      }
      setSend({ step: 'waiting', pending });
      // Подтверждение — по инкременту seqno (см. transfer.ts о безопасности повтора)
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const info = await refresh();
        if (info.seqno > pending.seqnoBefore) {
          setSend({ step: 'done' });
          setTo('');
          setAmount('');
          setComment('');
          return;
        }
      }
      throw new Error('Не дождались подтверждения (seqno не вырос за 2 минуты)');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSend({ step: 'idle' });
    }
  }

  // tonscan: свой индексер, не отстаёт вместе с tonapi/tonviewer
  const explorer = `https://testnet.tonscan.org/address/${address.nonBounceable}`;

  return (
    <DashboardView
      session={session}
      address={address}
      version={version}
      balance={balance}
      seqno={seqno}
      jettons={jettons}
      book={book}
      favorites={favorites}
      asset={asset}
      setAsset={setAsset}
      to={to}
      setTo={setTo}
      amount={amount}
      setAmount={setAmount}
      comment={comment}
      setComment={setComment}
      send={send}
      setSend={setSend}
      error={error}
      setError={setError}
      prepare={prepare}
      confirmSend={confirmSend}
      refresh={refresh}
      onLock={props.onLock}
      onDappRequest={handleDappRequest}
      reloadBook={reloadBook}
      reloadFavorites={reloadFavorites}
      explorer={explorer}
    />
  );
}

interface DashboardViewProps {
  session: Session;
  address: WalletAddress;
  version: WalletVersion;
  balance: bigint | null;
  seqno: number;
  jettons: JettonBalance[];
  book: AddressBookEntry[];
  favorites: FavoriteAddress[];
  asset: string;
  setAsset: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  comment: string;
  setComment: (v: string) => void;
  send: SendState;
  setSend: (s: SendState) => void;
  error: string | null;
  setError: (e: string | null) => void;
  prepare: () => Promise<void>;
  confirmSend: (p: PendingSend) => Promise<void>;
  refresh: () => Promise<{ balance: string; deployed: boolean; seqno: number }>;
  onLock: () => void;
  onDappRequest: (req: DappTxRequest) => Promise<void>;
  reloadBook: () => void;
  reloadFavorites: () => void;
  explorer: string;
}

function DashboardView(p: DashboardViewProps) {
  const toast = useToast();
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  // Открываем шторку отправки, если запустился confirm (в т.ч. по запросу от dApp).
  useEffect(() => {
    if (
      p.send.step === 'preparing' ||
      p.send.step === 'confirm' ||
      p.send.step === 'sending' ||
      p.send.step === 'waiting'
    ) {
      setSendOpen(true);
    }
    if (p.send.step === 'done') {
      toast.push('success', 'Отправлено и подтверждено (seqno вырос)');
      setSendOpen(false);
      const t = setTimeout(() => p.setSend({ step: 'idle' }), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [p.send.step, toast, p]);

  // Ошибки из потока — тостом.
  useEffect(() => {
    if (p.error) {
      toast.push('danger', p.error);
      p.setError(null);
    }
  }, [p, toast]);

  const openSend = (preselectAsset?: string) => {
    if (preselectAsset) p.setAsset(preselectAsset);
    setSendOpen(true);
  };
  const closeSend = () => {
    if (p.send.step === 'idle' || p.send.step === 'done') setSendOpen(false);
  };

  const selectedJetton = p.jettons.find((j) => j.jettonMaster === p.asset);

  const setMax = () => {
    if (p.asset === 'TON' && p.balance !== null) {
      // Оставляем небольшой запас на комиссию — 0.01 TON.
      const reserve = 10_000_000n;
      const max = p.balance > reserve ? p.balance - reserve : 0n;
      p.setAmount(formatTonAmount(max));
    } else if (selectedJetton) {
      p.setAmount(formatTokenAmount(BigInt(selectedJetton.balance), selectedJetton.decimals));
    }
  };

  return (
    <>
      {/* Топбар */}
      <div className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = '';
          }}
        >
          grampocket
        </a>
        <span className="pill pill-amber">testnet · {p.version}</span>
      </div>

      {/* Герой */}
      <section className="hero">
        <div className="balance-label">Баланс</div>
        <HeroBalance nano={p.balance} />
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
          <AddressChip value={p.address.nonBounceable} />
        </div>
        <div className="hero-meta">
          seqno {p.seqno} ·{' '}
          <a href={p.explorer} target="_blank" rel="noreferrer">
            открыть в tonscan
          </a>{' '}
          · <a href={profileHref(p.address.nonBounceable)}>мой профиль</a>
        </div>
      </section>

      {/* Сетка действий */}
      <div className="action-grid">
        <button
          type="button"
          className="action-btn primary"
          onClick={() => openSend()}
          aria-label="Отправить"
        >
          <IconSend />
          Отправить
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={() => setReceiveOpen(true)}
          aria-label="Получить"
        >
          <IconReceive />
          Получить
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={() => p.refresh().catch((e) => toast.push('danger', String(e)))}
          aria-label="Обновить"
        >
          <IconRefresh />
          Обновить
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={p.onLock}
          aria-label="Заблокировать"
        >
          <IconLock />
          Блок
        </button>
      </div>

      {/* Активы */}
      <section className="card">
        <h3 className="card-title">Активы</h3>
        <AssetRow
          icon="ton"
          name="GRAM"
          sub="The Open Network"
          amount={p.balance === null ? '…' : formatTonAmount(p.balance)}
          unit="GRAM"
          onClick={() => openSend('TON')}
        />
        {p.jettons.map((j) => {
          const fake = detectFakeToken({
            symbol: j.symbol,
            name: j.name,
            masterRaw: j.jettonMaster,
            network: NETWORK,
          });
          const sym = j.symbol ?? j.name ?? 'JETTON';
          return (
            <AssetRow
              key={j.jettonMaster}
              icon={sym.slice(0, 2).toUpperCase()}
              name={sym}
              sub={`${j.jettonMaster.slice(0, 6)}…${j.jettonMaster.slice(-4)}`}
              amount={formatTokenAmount(BigInt(j.balance), j.decimals)}
              unit={sym}
              {...(fake?.message ? { warn: fake.message } : {})}
              onClick={() => openSend(j.jettonMaster)}
            />
          );
        })}
      </section>

      {/* Сервисы — свёрнуты в details, объединены секцией */}
      <section className="card">
        <h3 className="card-title">Сервисы</h3>
        <NotificationsCard session={p.session} address={p.address} version={p.version} />
        <TonConnectPanel
          session={p.session}
          version={p.version}
          onTxRequest={(req) => void p.onDappRequest(req)}
        />
        <AddressBook book={p.book} onChange={p.reloadBook} />
        <Favorites items={p.favorites} onChange={p.reloadFavorites} />
      </section>

      {/* История */}
      <History
        address={p.address}
        reloadKey={p.seqno}
        labels={new Map(p.book.map((e) => [e.raw, e.label]))}
        jettons={p.jettons}
      />

      {/* Шторка «Получить» */}
      <BottomSheet open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Получить">
        <p style={{ margin: '4px 0 12px', color: 'var(--muted)' }}>
          Отсканируй QR или скопируй адрес — придёт в этот кошелёк.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0' }}>
          <QrCode data={`ton://transfer/${p.address.nonBounceable}`} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <AddressChip value={p.address.nonBounceable} />
        </div>
      </BottomSheet>

      {/* Шторка «Отправить»: одна и та же для формы и подтверждения */}
      <BottomSheet
        open={sendOpen}
        onClose={closeSend}
        title={
          p.send.step === 'confirm' || p.send.step === 'sending' || p.send.step === 'waiting'
            ? 'Подтверждение'
            : 'Отправить'
        }
      >
        {(p.send.step === 'idle' || p.send.step === 'preparing') && (
          <fieldset disabled={p.send.step === 'preparing'} style={{ border: 0, padding: 0, margin: 0 }}>
            <p style={{ margin: '0 0 6px' }}>
              <label htmlFor="asset">
                <small>Актив</small>
              </label>
              <br />
              <select
                id="asset"
                value={p.asset}
                onChange={(e) => p.setAsset(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="TON">GRAM (нативный)</option>
                {p.jettons.map((j) => (
                  <option key={j.jettonMaster} value={j.jettonMaster}>
                    {j.symbol ?? j.name ?? j.jettonMaster.slice(0, 10)} (
                    {formatTokenAmount(BigInt(j.balance), j.decimals)})
                  </option>
                ))}
              </select>
            </p>
            <p style={{ margin: '8px 0 6px' }}>
              <label htmlFor="to">
                <small>Кому (raw или friendly)</small>
              </label>
              <br />
              <input
                id="to"
                value={p.to}
                onChange={(e) => p.setTo(e.target.value)}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                className="mono"
              />
            </p>
            <p style={{ margin: '8px 0 6px' }}>
              <label htmlFor="amount">
                <small>Сумма</small>
              </label>
              <br />
              <span style={{ display: 'flex', gap: 8 }}>
                <input
                  id="amount"
                  value={p.amount}
                  onChange={(e) => p.setAmount(e.target.value)}
                  inputMode="decimal"
                  className="mono"
                />
                <button type="button" onClick={setMax}>
                  MAX
                </button>
              </span>
            </p>
            <p style={{ margin: '8px 0 12px' }}>
              <label htmlFor="comment">
                <small>Комментарий</small>
              </label>
              <br />
              <input
                id="comment"
                value={p.comment}
                onChange={(e) => p.setComment(e.target.value)}
                maxLength={120}
              />
            </p>
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={() => void p.prepare()}
            >
              {p.send.step === 'preparing' ? 'Готовим…' : 'Продолжить'}
            </button>
          </fieldset>
        )}

        {(() => {
          const s = p.send;
          if (s.step !== 'confirm' && s.step !== 'sending' && s.step !== 'waiting') return null;
          const pending = s.pending;
          const step = s.step;
          return (
            <fieldset
              disabled={step !== 'confirm'}
              style={{ border: 0, padding: 0, margin: 0 }}
            >
              {pending.dapp && (
                <p className="dapp-notice">
                  Запрос от dApp: <b>{pending.dapp.connection.appName}</b>{' '}
                  <small style={{ wordBreak: 'break-all' }}>
                    ({pending.dapp.connection.appUrl})
                  </small>
                </p>
              )}
              <p style={{ wordBreak: 'break-all', margin: '10px 0 6px' }}>
                <small>Кому</small>
                <br />
                <a href={profileHref(pending.recipient.raw)}>{pending.recipient.friendly}</a>{' '}
                <button
                  type="button"
                  onClick={() => {
                    const r = pending.recipient;
                    void saveFavorite({
                      raw: r.raw,
                      friendly: r.friendly,
                      addedAt: Date.now(),
                    }).then(() => {
                      p.reloadFavorites();
                      toast.push('success', 'Добавлено в избранное');
                    });
                  }}
                >
                  ★ В избранное
                </button>
              </p>
              <p style={{ margin: '10px 0 6px' }}>
                <small>Сумма</small>
                <br />
                <b>{pending.displayAmount}</b>
              </p>
              {pending.comment && (
                <p style={{ margin: '10px 0 6px' }}>
                  <small>Комментарий</small>
                  <br />
                  {pending.comment}
                </p>
              )}
              <RecipientCard
                intel={pending.intel}
                {...(pending.label !== undefined ? { label: pending.label } : {})}
              />
              <SimulationView report={pending.report} />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => {
                    const dapp = pending.dapp;
                    if (dapp) {
                      void dapp
                        .reply(
                          JSON.stringify(
                            buildSendTransactionError(
                              dapp.request.id,
                              TONCONNECT_USER_DECLINED,
                              'Пользователь отклонил',
                            ),
                          ),
                        )
                        .catch(() => {});
                    }
                    p.setSend({ step: 'idle' });
                    setSendOpen(false);
                  }}
                  style={{ flex: 1 }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void p.confirmSend(pending)}
                  disabled={step !== 'confirm' || pending.report.verdict === 'danger'}
                  style={{ flex: 2 }}
                >
                  {step === 'sending'
                    ? 'Отправляем…'
                    : step === 'waiting'
                      ? 'Ждём seqno…'
                      : 'Подтвердить'}
                </button>
              </div>
            </fieldset>
          );
        })()}
      </BottomSheet>
    </>
  );
}

function HeroBalance(props: { nano: bigint | null }) {
  if (props.nano === null) return <div className="balance">…</div>;
  const str = formatTonAmount(props.nano);
  const dot = str.indexOf('.');
  const intPart = dot < 0 ? str : str.slice(0, dot);
  const frac = dot < 0 ? '' : str.slice(dot);
  return (
    <div className="balance">
      {intPart}
      {frac && <span className="balance-frac">{frac}</span>}
      <span className="balance-unit">GRAM</span>
    </div>
  );
}

function AssetRow(props: {
  icon: string;
  name: string;
  sub: string;
  amount: string;
  unit: string;
  warn?: string;
  onClick: () => void;
}) {
  return (
    <div
      className="asset-row"
      onClick={props.onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      {props.icon === 'ton' ? (
        <GramLogo size={36} />
      ) : (
        <div className="asset-icon">{props.icon}</div>
      )}
      <div className="asset-main">
        <div className="asset-name">
          {props.name}
          {props.warn && (
            <span className="severity-danger" style={{ marginLeft: 8, fontSize: '0.78rem' }}>
              ⚠ {props.warn}
            </span>
          )}
        </div>
        <div className="asset-sub">{props.sub}</div>
      </div>
      <div className="asset-amt">
        {props.amount}
        <small>{props.unit}</small>
      </div>
    </div>
  );
}
