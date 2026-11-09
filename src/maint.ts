// Щоденні завдання під роллю school_maint (розділ 13, «Дані й міграції»):
//   журнал дій — 1 рік; надіслані рядки outbox і рядки inbox — 7 днів.
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from './db/index.js';

export interface CleanupResult {
  audit: number;
  outbox: number;
  inbox: number;
}

export async function cleanup(maintDb: Db, now: Date = new Date()): Promise<CleanupResult> {
  const audit = await maintDb
    .deleteFrom('audit_log')
    .where('at', '<', sql<Date>`${now}::timestamptz - interval '1 year'`)
    .executeTakeFirst();
  const outbox = await maintDb
    .deleteFrom('outbox')
    .where('published_at', 'is not', null)
    .where('published_at', '<', sql<Date>`${now}::timestamptz - interval '7 days'`)
    .executeTakeFirst();
  const inbox = await maintDb
    .deleteFrom('inbox')
    .where('received_at', '<', sql<Date>`${now}::timestamptz - interval '7 days'`)
    .executeTakeFirst();
  return { audit: Number(audit.numDeletedRows), outbox: Number(outbox.numDeletedRows), inbox: Number(inbox.numDeletedRows) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Перший прохід через хвилину після старту, далі раз на добу. */
export function scheduleCleanup(maintDb: Db, log: FastifyBaseLogger): () => void {
  const run = () =>
    cleanup(maintDb)
      .then((r) => log.info(r, 'щоденна чистка'))
      .catch((err) => log.error({ err }, 'щоденна чистка не вдалася'));
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, DAY_MS);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
