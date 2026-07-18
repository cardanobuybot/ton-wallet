// Нижняя шторка с оверлеем: Esc закрывает, клик по подложке — тоже.
// Скролл body блокируется, пока шторка открыта. Никакой библиотеки.
import { useEffect, type ReactNode } from 'react';

export function BottomSheet(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!props.open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  return (
    <>
      <div className="sheet-overlay" onClick={props.onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        {...(props.title ? { 'aria-label': props.title } : {})}
      >
        <div className="sheet-handle" aria-hidden="true" />
        {props.title && <h2>{props.title}</h2>}
        {props.children}
      </div>
    </>
  );
}
