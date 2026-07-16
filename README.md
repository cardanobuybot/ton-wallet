# ton-wallet

Некастодиальный веб-кошелёк для блокчейна TON (PWA). «Кошелёк, который не даёт обмануть»:
анти-скам проверки и симуляция транзакций перед подписью.

**Статус:** спринт 0 — скелет и крипто-ядро «мнемоника → адрес W5». Только testnet.

## Пакеты

| Пакет | Описание |
| --- | --- |
| `packages/core` | Крипто-ядро: мнемоника (TON-схема), ключи, адреса W5. Чистый TS, работает в браузере и Node. |
| `apps/web` | PWA-клиент (Vite + React). Ключи существуют только на клиенте. |
| `apps/api` | Fastify API (health-check). Никогда не касается ключей и подписи. |

## Требования

Node >= 22, npm >= 10.

## Команды

```bash
npm install            # установка всех workspaces
npm run typecheck      # tsc --noEmit во всех пакетах
npm run lint           # eslint
npm test               # vitest в packages/core

npm run dev -w apps/web   # dev-сервер фронтенда (Vite)
npm run dev -w apps/api   # dev-сервер API (порт из PORT, по умолчанию 3000)
```

## Лицензия

GPL-3.0-only (см. LICENSE).
