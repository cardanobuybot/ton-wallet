import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildSimulationReport,
  createTransfer,
  decryptMnemonic,
  encryptMnemonic,
  formatTonAmount,
  generateMnemonic,
  getWalletAddress,
  mnemonicToKeyPair,
  parseRecipientAddress,
  parseTonAmount,
  resolveBounce,
  validateMnemonic,
  type Severity,
  type SimulationReport,
  type WalletAddress,
} from '@ton-wallet/core';
import qrcode from 'qrcode-generator';
import { emulate, estimateFee, getAccount, sendBoc } from './api.ts';
import { AUTO_LOCK_MS, zeroizeSession, type Session } from './session.ts';
import { deleteEnvelope, loadEnvelope, saveEnvelope } from './storage.ts';

const NETWORK = 'testnet' as const;

type Screen =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'show-mnemonic'; mnemonic: string[] }
  | { name: 'import' }
  | { name: 'password'; mnemonic: string[] }
  | { name: 'locked' }
  | { name: 'wallet'; session: Session; address: WalletAddress };

interface PendingSend {
  toDisplay: string;
  amount: bigint;
  comment: string;
  fee: bigint;
  boc: string;
  seqnoBefore: number;
  report: SimulationReport;
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

  async function openWallet(mnemonic: string[]) {
    const keyPair = await mnemonicToKeyPair(mnemonic);
    const session: Session = { keyPair, mnemonic };
    sessionRef.current = session;
    const address = getWalletAddress(keyPair, { version: 'v5r1', network: NETWORK });
    setScreen({ name: 'wallet', session, address });
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
          <button onClick={() => setScreen({ name: 'password', mnemonic: screen.mnemonic })}>
            Я записал — дальше
          </button>
        </>
      )}

      {screen.name === 'import' && (
        <ImportForm
          onSubmit={(words) =>
            guard(async () => {
              if (!(await validateMnemonic(words))) {
                throw new Error('Невалидная мнемоника (нужны 24 слова TON-схемы)');
              }
              setScreen({ name: 'password', mnemonic: words });
            })
          }
          onBack={() => setScreen({ name: 'setup' })}
        />
      )}

      {screen.name === 'password' && (
        <PasswordForm
          label="Задай пароль (мин. 8 символов) — им шифруется мнемоника на этом устройстве"
          onSubmit={(password) =>
            guard(async () => {
              if (password.length < 8) throw new Error('Пароль короче 8 символов');
              await saveEnvelope(await encryptMnemonic(screen.mnemonic, password));
              await openWallet(screen.mnemonic);
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
                await openWallet(await decryptMnemonic(envelope, password));
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
        <Dashboard session={screen.session} address={screen.address} onLock={lock} />
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

type SendState =
  | { step: 'idle' }
  | { step: 'preparing' }
  | { step: 'confirm'; pending: PendingSend }
  | { step: 'sending'; pending: PendingSend }
  | { step: 'waiting'; pending: PendingSend }
  | { step: 'done' };

function Dashboard(props: { session: Session; address: WalletAddress; onLock: () => void }) {
  const { session, address } = props;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [seqno, setSeqno] = useState(0);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [send, setSend] = useState<SendState>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);

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
      const nano = parseTonAmount(amount);
      const [own, recipientInfo] = await Promise.all([
        refresh(),
        getAccount(recipient.address.toRawString()),
      ]);
      // Перевод на кошелёк: bounce=false; для незадеплоенного — принудительно false.
      const bounce = resolveBounce(false, recipientInfo.deployed);
      const transfer = createTransfer({
        keyPair: session.keyPair,
        version: 'v5r1',
        network: NETWORK,
        seqno: own.seqno,
        to: recipient.address,
        amount: nano,
        bounce,
        ...(comment ? { comment } : {}),
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
      const report = buildSimulationReport({
        event: emu?.ok ? (emu.event ?? null) : null,
        ...(emu?.rejected && emu.error ? { rejectionError: emu.error } : {}),
        emulatorOutdated,
        ownAddressRaw: address.raw,
        balance: BigInt(own.balance),
        enteredAmount: nano,
        recipientDeployed: recipientInfo.deployed,
        fallbackFee: BigInt(fee.totalFee),
      });
      setSend({
        step: 'confirm',
        pending: {
          toDisplay: to.trim(),
          amount: nano,
          comment,
          fee: BigInt(fee.totalFee),
          boc: transfer.bocBase64,
          seqnoBefore: own.seqno,
          report,
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
        Адрес (testnet): <b style={{ wordBreak: 'break-all' }}>{address.nonBounceable}</b>
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

      {(send.step === 'idle' || send.step === 'preparing') && (
        <fieldset disabled={send.step === 'preparing'}>
          <legend>Отправить TON</legend>
          <p>
            Кому (raw или friendly):{' '}
            <input style={{ width: '100%' }} value={to} onChange={(e) => setTo(e.target.value)} />
          </p>
          <p>
            Сумма TON: <input value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          <p style={{ wordBreak: 'break-all' }}>Кому: {send.pending.toDisplay}</p>
          <p>Сумма: {formatTonAmount(send.pending.amount)} TON</p>
          {send.pending.comment && <p>Комментарий: {send.pending.comment}</p>}
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
    </>
  );
}
