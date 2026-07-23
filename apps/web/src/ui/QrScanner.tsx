import { useEffect, useRef, useState } from 'react';
import { BottomSheet } from './BottomSheet.tsx';

// Камера + BarcodeDetector — zero-deps QR-сканер. Работает в мобильном
// Chrome (grampocket.com — mobile-first). Если BarcodeDetector в браузере
// нет, показываем понятное сообщение и просим вставить адрес вручную.

interface Props {
  open: boolean;
  onClose: () => void;
  onScan: (raw: string) => void;
  title?: string;
}

// TypeScript ещё не знает про BarcodeDetector — объявляем минимальные типы.
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

export function QrScanner({ open, onClose, onScan, title }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    const cleanup = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };

    (async () => {
      try {
        if (!window.BarcodeDetector) {
          setError(
            'Этот браузер не поддерживает нативный QR-сканер. Скопируй адрес и вставь его в поле «Кому».',
          );
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('Нет доступа к камере в этом браузере.');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            const hit = results.find((r) => r.rawValue && r.rawValue.trim().length > 0);
            if (hit) {
              cleanup();
              onScan(hit.rawValue.trim());
              return;
            }
          } catch {
            // Одиночные ошибки распознавания игнорируем — продолжаем цикл.
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        if (name === 'NotAllowedError') setError('Доступ к камере запрещён.');
        else if (name === 'NotFoundError') setError('Камера не найдена.');
        else setError(`Не удалось открыть камеру: ${String((e as Error).message ?? e)}`);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [open, onScan]);

  return (
    <BottomSheet open={open} onClose={onClose} title={title ?? 'Сканирование QR'}>
      {error ? (
        <p style={{ color: 'var(--red)' }}>{error}</p>
      ) : (
        <div>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{
              width: '100%',
              maxHeight: 380,
              background: '#000',
              borderRadius: 12,
              objectFit: 'cover',
            }}
          />
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
            Наведи камеру на QR-код с TON-адресом.
          </p>
        </div>
      )}
    </BottomSheet>
  );
}
