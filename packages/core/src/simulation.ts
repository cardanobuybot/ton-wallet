// Симуляция транзакции перед подписью — ядро продукта.
// Парсит ответ tonapi POST /v2/events/emulate в SimulationReport
// и накладывает правила предупреждений v0.

export type Severity = 'info' | 'warn' | 'danger';
export type SimulationVerdict = 'ok' | 'warn' | 'danger';

export interface SimulationWarning {
  severity: Severity;
  code: string;
  message: string;
}

export interface SimulationAction {
  type: string;
  status: string;
  description: string;
  amount?: bigint;
  recipientRaw?: string;
  recipientIsWallet?: boolean;
  recipientIsScam?: boolean;
}

export interface SimulationReport {
  /** false — эмуляция была недоступна, отчёт построен в fallback-режиме */
  emulated: boolean;
  actions: SimulationAction[];
  /** Изменение баланса нашего аккаунта (обычно отрицательное), нанотоны */
  balanceChange: bigint;
  fees: bigint;
  warnings: SimulationWarning[];
  verdict: SimulationVerdict;
}

interface TonapiAccount {
  address: string;
  is_scam: boolean;
  is_wallet: boolean;
}

interface TonapiEvent {
  actions: Array<{
    type: string;
    status: string;
    TonTransfer?: {
      recipient: TonapiAccount;
      amount: number | string;
      comment?: string;
    };
    simple_preview?: { description?: string };
  }>;
  value_flow: Array<{ account: TonapiAccount; ton: number | string; fees: number | string }>;
  is_scam: boolean;
}

// tonapi отдаёт суммы JSON-числами; переводим через строку, не через float-арифметику
const toBigInt = (v: number | string | undefined): bigint => BigInt(String(v ?? 0));

export interface BuildReportParams {
  /** Ответ tonapi (status 200). null — эмуляция недоступна (fallback). */
  event: unknown | null;
  /** Текст ошибки tonapi 4xx: эмулятор отверг сообщение — это danger, не fallback. */
  rejectionError?: string;
  /** raw-адрес нашего кошелька (`0:<hex>`) */
  ownAddressRaw: string;
  /** Текущий баланс, нанотоны */
  balance: bigint;
  /** Введённая пользователем сумма, нанотоны */
  enteredAmount: bigint;
  recipientDeployed: boolean;
  /** Оценка комиссии из dry-run — используется в fallback-режиме */
  fallbackFee?: bigint;
}

/** Допуск на комиссии при сравнении «итоговый расход vs введённая сумма» */
const SPEND_TOLERANCE = 100_000_000n; // 0.1 TON

export function buildSimulationReport(params: BuildReportParams): SimulationReport {
  const warnings: SimulationWarning[] = [];
  let actions: SimulationAction[] = [];
  let balanceChange = -params.enteredAmount - (params.fallbackFee ?? 0n);
  let fees = params.fallbackFee ?? 0n;
  let emulated = false;

  if (params.rejectionError !== undefined) {
    warnings.push({
      severity: 'danger',
      code: 'EMULATION_REJECTED',
      message: `Эмулятор отверг транзакцию — она не исполнится в сети. ${params.rejectionError}`,
    });
  } else if (params.event === null) {
    warnings.push({
      severity: 'warn',
      code: 'SIMULATION_UNAVAILABLE',
      message:
        'Симуляция недоступна — показана только оценка комиссии. Отправляй, только если уверен.',
    });
  } else {
    emulated = true;
    const event = params.event as TonapiEvent;
    const own = params.ownAddressRaw.toLowerCase();

    actions = event.actions.map((a) => {
      const transfer = a.TonTransfer;
      return {
        type: a.type,
        status: a.status,
        description: a.simple_preview?.description ?? a.type,
        ...(transfer
          ? {
              amount: toBigInt(transfer.amount),
              recipientRaw: transfer.recipient.address,
              recipientIsWallet: transfer.recipient.is_wallet,
              recipientIsScam: transfer.recipient.is_scam,
            }
          : {}),
      };
    });

    const ownFlow = event.value_flow.find((f) => f.account.address.toLowerCase() === own);
    if (ownFlow) {
      balanceChange = toBigInt(ownFlow.ton);
      fees = toBigInt(ownFlow.fees);
    }

    if (event.is_scam || actions.some((a) => a.recipientIsScam)) {
      warnings.push({
        severity: 'danger',
        code: 'SCAM_FLAG',
        message: 'Адрес помечен как скам. Отправка заблокирована.',
      });
    }
    for (const a of actions) {
      if (a.status !== 'ok') {
        warnings.push({
          severity: 'danger',
          code: 'ACTION_FAILED',
          message: `Действие «${a.description}» завершается ошибкой в симуляции.`,
        });
      }
      if (a.recipientIsWallet === false) {
        warnings.push({
          severity: 'warn',
          code: 'CONTRACT_RECIPIENT',
          message: 'Получатель — смарт-контракт, а не кошелёк. Убедись, что понимаешь, что он сделает с TON.',
        });
      }
    }
    const spend = -balanceChange;
    if (spend > params.enteredAmount + SPEND_TOLERANCE) {
      warnings.push({
        severity: 'warn',
        code: 'SPEND_EXCEEDS_AMOUNT',
        message: 'Итоговый расход заметно больше введённой суммы.',
      });
    }
  }

  // > 50% баланса → warn
  if (params.enteredAmount * 2n > params.balance) {
    warnings.push({
      severity: 'warn',
      code: 'LARGE_TRANSFER',
      message: 'Сумма больше половины баланса.',
    });
  }
  if (!params.recipientDeployed) {
    warnings.push({
      severity: 'info',
      code: 'RECIPIENT_NOT_DEPLOYED',
      message: 'Кошелёк получателя ещё не задеплоен — это нормально для нового адреса (bounce отключён).',
    });
  }

  const verdict: SimulationVerdict = warnings.some((w) => w.severity === 'danger')
    ? 'danger'
    : warnings.some((w) => w.severity === 'warn')
      ? 'warn'
      : 'ok';

  return { emulated, actions, balanceChange, fees, warnings, verdict };
}
