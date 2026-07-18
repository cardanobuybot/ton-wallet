// Соединение с Postgres и миграции. Никаких приватных ключей и подписей
// (правило проекта): храним только публичные данные — адреса, ники, follows.
// При отсутствии DATABASE_URL модуль возвращает null: локальный dev без БД
// не должен падать в 500 на не-БД эндпоинтах.
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

let sqlSingleton: ReturnType<typeof postgres> | null = null;

export function sql() {
  if (!DATABASE_URL) return null;
  if (!sqlSingleton) {
    sqlSingleton = postgres(DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Railway всегда даёт ssl=require в URL; на dev-локали это игнорируется
    });
  }
  return sqlSingleton;
}

/**
 * Идемпотентные миграции: DDL под IF NOT EXISTS. Прогоняются на старте сервера.
 * Схема специально минимальна — таблиц ровно две, ключи по raw-адресу.
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS usernames (
    address_raw TEXT PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Регистронезависимый поиск по никам без ILIKE-таблсканов
  `CREATE UNIQUE INDEX IF NOT EXISTS usernames_username_lower_idx
     ON usernames ((lower(username)))`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_raw TEXT NOT NULL,
    target_raw   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_raw, target_raw)
  )`,
  `CREATE INDEX IF NOT EXISTS follows_target_idx ON follows (target_raw)`,
];

export async function runMigrations(): Promise<void> {
  const s = sql();
  if (!s) return;
  for (const ddl of MIGRATIONS) {
    await s.unsafe(ddl);
  }
}
