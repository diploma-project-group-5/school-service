// Точка входу: npm run dev (локально) або node dist/server.js (контейнер).
// Один процес: публічний HTTP, внутрішній HTTP, relay outbox → Kafka, консюмер і щоденна чистка.
import { buildApp, LOG_REDACT } from './app.js';
import { createTokenVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { handlers } from './domain/events.js';
import { buildInternalApp } from './internal.js';
import { superviseConsumer, type ConsumerHandle } from './kafka/consumer.js';
import { createProducer, createSource } from './kafka/platformatic.js';
import { startRelay, type RelayHandle } from './kafka/relay.js';
import type { Producer } from './kafka/bus.js';
import { scheduleCleanup } from './maint.js';

const config = loadConfig();
const logger = { level: config.logLevel, redact: LOG_REDACT };

// Три пули з різними ролями (розділ 03): app — запити, relay — outbox, maint — чистка.
const db = createDb(config.databaseUrl);
const relayDb = createDb(config.relayDatabaseUrl, 2);
const maintDb = createDb(config.maintDatabaseUrl, 1);

const app = buildApp({
  db,
  verifyToken: createTokenVerifier({ issuer: config.oidcIssuer, clientId: config.oidcClientId, keys: remoteKeys(config.oidcJwksUrl) }),
  logger,
});
const internal = buildInternalApp({ db, logger });

let producer: Producer | undefined;
let consumer: ConsumerHandle | undefined;
let relay: RelayHandle | undefined;
if (config.kafkaBrokers.length > 0) {
  producer = createProducer({ brokers: config.kafkaBrokers, clientId: config.kafkaClientId });
  relay = startRelay(relayDb, producer, app.log.child({ component: 'relay' }), config.relayIntervalMs);
  // Падіння Kafka не зупиняє процес з HTTP-API: консюмер перезапускається сам (Z6-2).
  consumer = superviseConsumer(
    () => createSource({ brokers: config.kafkaBrokers, clientId: config.kafkaClientId, groupId: config.kafkaGroupId, topics: Object.keys(handlers) }),
    { db, producer, handlers, log: app.log.child({ component: 'consumer' }) },
  );
} else {
  app.log.warn('KAFKA_BROKERS не задано: події не відправляються й не приймаються');
}
const stopCleanup = scheduleCleanup(maintDb, app.log.child({ component: 'maint' }));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'зупинка');
  stopCleanup();
  await Promise.allSettled([app.close(), internal.close()]);
  await relay?.stop();
  await consumer?.stop();
  await producer?.close().catch(() => undefined);
  await Promise.allSettled([db.destroy(), relayDb.destroy(), maintDb.destroy()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
await internal.listen({ host: config.host, port: config.internalPort });
