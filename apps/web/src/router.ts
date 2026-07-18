// Простой hash-роутер без зависимостей. Хеш выбран сознательно:
// SPA-рерайты в vercel.json остаются как есть, ссылки вида
// grampocket.com/#/u/0:abcd… работают без изменений хостинга.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'profile'; address: string };

function parseHash(hash: string): Route {
  // Ожидаем "#/u/<raw-address>" или "#/u/<friendly-address>"
  const m = /^#\/u\/([^/?#]+)/.exec(hash);
  if (m && m[1]) return { name: 'profile', address: decodeURIComponent(m[1]) };
  return { name: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function profileHref(rawOrFriendly: string): string {
  return `#/u/${encodeURIComponent(rawOrFriendly)}`;
}

export function navigate(route: Route): void {
  const hash = route.name === 'home' ? '' : profileHref(route.address);
  if (window.location.hash !== hash) window.location.hash = hash;
}
