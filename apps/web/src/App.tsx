import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeRecipient,
  applyWarnings,
  buildJettonTransferBody,
  buildSimulationReport,
  createTransfer,
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
import {
  deleteAddressBookEntry,
  deleteEnvelope,
  listAddressBook,
  loadEnvelope,
  loadWalletVersion,
  saveAddressBookEntry,
  saveEnvelope,
  saveWalletVersion,
  type AddressBookEntry,
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
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [error, setError] = useState<string | null>(null);
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
    <main style={{ fontFamily: 'monospace', maxWidth: 640, margin: '2rem auto', padding: 16 }}>
      <p style={{ background: '#b00', color: '#fff', padding: 8, textAlign: 'center' }}>
        <b>DEV ONLY — testnet.</b> Не использовать с реальными средствами.
      </p>
      <h1>ton-wallet</h1>
      {error && <p style={{ color: 'red' }}>Ошибка: {error}</p>}

      {screen.name === 'loading' && <p>Загрузка…</p>}

      {screen.name === 'setup' && (
        <>
          <button onClick={() => guard(async () => {
            setScreen({ name: 'show-mnemonic', mnemonic: await generateMnemonic() });
          })}>
            Создать новый кошелёк
          </button>{' '}
          <button onClick={() => setScreen({ name: 'import' })}>Импортировать (24 слова)</button>
        </>
      )}

      {screen.name === 'show-mnemonic' && (
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

      {screen.name === 'verify-mnemonic' && (
        <MnemonicQuiz
          mnemonic={screen.mnemonic}
          onPass={() => setScreen({ name: 'password', mnemonic: screen.mnemonic, version: 'v5r1' })}
          onBack={() => setScreen({ name: 'show-mnemonic', mnemonic: screen.mnemonic })}
        />
      )}

      {screen.name === 'import' && (
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

      {screen.name === 'choose-version' && (
        <VersionPicker
          mnemonic={screen.mnemonic}
          onPick={(version) => setScreen({ name: 'password', mnemonic: screen.mnemonic, version })}
          onBack={() => setScreen({ name: 'import' })}
        />
      )}

      {screen.name === 'password' && (
        <PasswordForm
          label="Задай пароль (мин. 8 символов) — им шифруется мнемоника на этом устройстве"
          onSubmit={(password) =>
            guard(async () => {
              if (password.length < 8) throw new Error('Пароль короче 8 символов');
              await saveEnvelope(await encryptMnemonic(screen.mnemonic, password));
              await saveWalletVersion(screen.version);
              await openWallet(screen.mnemonic, screen.version);
            })
          }
        />
      )}

      {screen.name === 'locked' && (
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

      {screen.name === 'wallet' && (
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
      {wrong && <p style={{ color: 'red' }}>Есть ошибки — сверься с записанной мнемоникой.</p>}
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
      <p>{props.label}</p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />{' '}
      <button type="submit">{props.submitText ?? 'Сохранить'}</button>
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
        Изменение баланса: <b>{formatTonAmount(report.balanceChange)} TON</b> (комиссии ~
        {formatTonAmount(report.fees)} TON)
      </p>
      {report.actions.map((a, i) => (
        <p key={i} style={{ margin: '0 0 4px' }}>
          {a.type}: {a.description}
          {a.amount !== undefined && <> — {formatTonAmount(a.amount)} TON</>}
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
          <span style={{ color: 'green' }}>«{label}» (из адресной книги)</span>
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
      <summary>Адресная книга ({props.book.length})</summary>
      {error && <p style={{ color: 'red' }}>Ошибка: {error}</p>}
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

const txHashHex = (base64: string): string =>
  Array.from(atob(base64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function History(props: {
  address: WalletAddress;
  reloadKey: number;
  labels: ReadonlyMap<string, string>;
}) {
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
    <fieldset>
      <legend>История</legend>
      {error && <p style={{ color: 'red' }}>Ошибка: {error}</p>}
      {items.length === 0 && !loading && !error && <p>Транзакций пока нет.</p>}
      {items.map((t) => (
        <p key={`${t.lt}:${t.hash}`} style={{ margin: '4px 0' }}>
          <span style={{ color: t.direction === 'in' ? 'green' : '#b00' }}>
            {t.direction === 'in' ? '+' : '−'}
            {formatTonAmount(t.amount)} TON
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
          <br />
          {t.counterparty && (
            <small style={{ wordBreak: 'break-all' }}>
              {t.direction === 'in' ? 'от' : 'кому'}:{' '}
              {props.labels.has(t.counterparty.raw) && (
                <b style={{ color: 'green' }}>«{props.labels.get(t.counterparty.raw)}» </b>
              )}
              {t.counterparty.friendly}
            </small>
          )}
          {t.comment && (
            <>
              <br />
              <small>«{t.comment}»</small>
            </>
          )}
        </p>
      ))}
      {loading && <p>Загрузка…</p>}
      {!loading && last && !exhausted && (
        <button onClick={() => load({ lt: last.lt, hash: last.hash })}>Ещё</button>
      )}
    </fieldset>
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
        }),
        // Анти-скам по локальной истории: address poisoning (danger) блокирует
        analyzeRecipient({
          recipient: recipientCp,
          history: ownHistory,
          recipientLabeled: label !== undefined,
        }),
      );
      setSend({
        step: 'confirm',
        pending: {
          amount: attached,
          displayAmount: selected
            ? `${formatTokenAmount(nano, selected.decimals)} ${selected.symbol ?? selected.name ?? 'JETTON'} (+ ${formatTonAmount(attached)} TON газ)`
            : `${formatTonAmount(nano)} TON`,
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

  async function confirmSend(pending: PendingSend) {
    setError(null);
    setSend({ step: 'sending', pending });
    try {
      await sendBoc(pending.boc);
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
    <>
      <p>
        Адрес (testnet, {version}): <b style={{ wordBreak: 'break-all' }}>{address.nonBounceable}</b>
        <br />
        Баланс: <b>{balance === null ? '…' : `${formatTonAmount(balance)} TON`}</b> (seqno {seqno}){' '}
        <button onClick={() => refresh().catch((e) => setError(String(e)))}>Обновить</button>{' '}
        <button onClick={props.onLock}>Заблокировать</button>
      </p>
      <p>
        <a href={explorer} target="_blank" rel="noreferrer">
          Открыть в tonscan (testnet)
        </a>
      </p>
      <details>
        <summary>Получить TON (QR)</summary>
        <p>
          <QrCode data={`ton://transfer/${address.nonBounceable}`} />
        </p>
        <p style={{ wordBreak: 'break-all' }}>
          {address.nonBounceable}{' '}
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(address.nonBounceable)
                .catch((e) => setError(String(e)))
            }
          >
            Скопировать адрес
          </button>
        </p>
      </details>
      {error && <p style={{ color: 'red' }}>Ошибка: {error}</p>}

      {jettons.length > 0 && (
        <fieldset>
          <legend>Джеттоны</legend>
          {jettons.map((j) => (
            <p key={j.jettonMaster} style={{ wordBreak: 'break-all', margin: '4px 0' }}>
              <b>{formatTokenAmount(BigInt(j.balance), j.decimals)}</b>{' '}
              {j.symbol ?? j.name ?? 'без имени'}{' '}
              <button onClick={() => setAsset(j.jettonMaster)}>Отправить</button>
              <br />
              <small>master: {j.jettonMaster}</small>
            </p>
          ))}
        </fieldset>
      )}

      {(send.step === 'idle' || send.step === 'preparing') && (
        <fieldset disabled={send.step === 'preparing'}>
          <legend>Отправить</legend>
          <p>
            Актив:{' '}
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="TON">TON</option>
              {jettons.map((j) => (
                <option key={j.jettonMaster} value={j.jettonMaster}>
                  {j.symbol ?? j.name ?? j.jettonMaster.slice(0, 10)} (
                  {formatTokenAmount(BigInt(j.balance), j.decimals)})
                </option>
              ))}
            </select>
          </p>
          <p>
            Кому (raw или friendly):{' '}
            <input style={{ width: '100%' }} value={to} onChange={(e) => setTo(e.target.value)} />
          </p>
          <p>
            Сумма: <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </p>
          <p>
            Комментарий:{' '}
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={120} />
          </p>
          <button onClick={prepare}>
            {send.step === 'preparing' ? 'Готовим…' : 'Продолжить'}
          </button>
        </fieldset>
      )}

      {(send.step === 'confirm' || send.step === 'sending' || send.step === 'waiting') && (
        <fieldset disabled={send.step !== 'confirm'}>
          <legend>Подтверждение</legend>
          <p style={{ wordBreak: 'break-all' }}>Кому: {send.pending.recipient.friendly}</p>
          <p>Сумма: {send.pending.displayAmount}</p>
          {send.pending.comment && <p>Комментарий: {send.pending.comment}</p>}
          <RecipientCard
            intel={send.pending.intel}
            {...(send.pending.label !== undefined ? { label: send.pending.label } : {})}
          />
          <SimulationView report={send.pending.report} />
          <button
            onClick={() => confirmSend(send.pending)}
            disabled={send.pending.report.verdict === 'danger'}
          >
            {send.step === 'sending'
              ? 'Отправляем…'
              : send.step === 'waiting'
                ? 'Ждём подтверждения (seqno)…'
                : 'Подтвердить и отправить'}
          </button>{' '}
          <button onClick={() => setSend({ step: 'idle' })}>Отмена</button>
        </fieldset>
      )}

      {send.step === 'done' && (
        <p style={{ color: 'green' }}>
          Отправлено и подтверждено (seqno вырос).{' '}
          <a href={explorer} target="_blank" rel="noreferrer">
            Смотреть в tonscan
          </a>{' '}
          <button onClick={() => setSend({ step: 'idle' })}>Ок</button>
        </p>
      )}

      <AddressBook book={book} onChange={reloadBook} />

      <History
        address={address}
        reloadKey={seqno}
        labels={new Map(book.map((e) => [e.raw, e.label]))}
      />
    </>
  );
}
