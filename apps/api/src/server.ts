// ПРАВИЛО ПРОЕКТА: этот сервис никогда не касается приватных ключей,
// мнемоник и подписи. Только публичные данные.
import Fastify from 'fastify';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: true });

app.get('/health', () => ({ status: 'ok' }));

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
