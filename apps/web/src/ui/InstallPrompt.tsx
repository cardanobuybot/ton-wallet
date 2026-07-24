import { useEffect, useState } from 'react';

// Установка PWA. Chrome/Edge на Android + Chrome на desktop сами кидают
// beforeinstallprompt — перехватываем и показываем свой баннер (без него
// браузер прячет ничем не заметный мини-инфобар). iOS Safari не даёт
// программный prompt — только ручное «Поделиться → На экран Домой»;
// для iOS показываем текстовую подсказку.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_KEY = 'grampocket:install-dismissed';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari signals installed-as-webapp via a non-standard flag.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ маскируется под Mac — проверяем touch, чтобы не показывать
  // подсказку установки на настоящем macOS-браузере (там PWA-установки нет).
  const isIpadOs =
    /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || isIpadOs;
}

export function InstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(DISMISSED_KEY) === '1';
  });
  const [installed, setInstalled] = useState<boolean>(() => isStandalone());
  const iosHint = !installed && !dismissed && isIos();

  useEffect(() => {
    if (installed) return undefined;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [installed]);

  if (installed) return null;
  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  const install = async () => {
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    setEvent(null);
    if (outcome === 'accepted') {
      setInstalled(true);
    } else {
      // Пользователь отказался — не тревожим до следующего визита в свежей
      // сессии. Постоянно баннер не прячем: iOS/Chrome могут снова
      // предложить, если пользователь передумает.
      dismiss();
    }
  };

  // Chrome/Edge: у нас есть prompt-событие → кнопка «Установить».
  if (event) {
    return (
      <div className="install-banner">
        <div>
          <b>Установить grampocket</b>
          <br />
          <small>
            Быстрый запуск с иконки, локальные данные защищены от очистки браузером,
            уведомления работают надёжнее.
          </small>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" className="btn-primary" onClick={() => void install()}>
            Установить
          </button>
          <button type="button" onClick={dismiss}>
            Позже
          </button>
        </div>
      </div>
    );
  }

  // iOS Safari: программный prompt недоступен — инструкция вручную.
  if (iosHint) {
    return (
      <div className="install-banner">
        <div>
          <b>Установи grampocket на iPhone</b>
          <br />
          <small>
            Нажми «Поделиться» <span aria-hidden>▲</span> в Safari → «На экран „Домой“»
            (Add to Home Screen). Ключи станут защищены от очистки браузера.
          </small>
        </div>
        <button type="button" onClick={dismiss} style={{ flexShrink: 0 }}>
          Закрыть
        </button>
      </div>
    );
  }

  return null;
}
