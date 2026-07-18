// Компактный чип с обрезанным адресом: тап копирует в буфер и подсвечивает.
// Для приватных данных не используется (только публичные адреса кошельков).
import { useState } from 'react';

function shorten(s: string, head = 6, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function AddressChip(props: {
  value: string;
  short?: { head?: number; tail?: number };
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard недоступен — молча */
    }
  };

  const display = shorten(props.value, props.short?.head ?? 6, props.short?.tail ?? 4);

  return (
    <button
      type="button"
      className={`address-chip${copied ? ' copied' : ''}`}
      onClick={onClick}
      title={props.value}
      aria-label={props.label ?? 'Скопировать адрес'}
    >
      {props.label && <small>{props.label}</small>}
      <span>{copied ? 'Скопировано' : display}</span>
    </button>
  );
}
