// Минимальный тост-провайдер через контекст. Auto-dismiss 3–5 сек.
// Заменяет alert()/setError() красной строкой в потоке.
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'info' | 'success' | 'warn' | 'danger';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastCtx {
  push: (kind: ToastKind, text: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'danger' ? 5000 : 3000);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {props.children}
      {items.length > 0 && (
        <div className="toast-stack" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`} role="status">
              {t.text}
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast: обёрни ToastProvider');
  return ctx;
}
