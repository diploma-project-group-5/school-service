// Вхідні події (inbox, повтори), консюмер (3 спроби → DLQ), relay outbox → Kafka, щоденна чистка.
// Kafka тут — шина в пам'яті; справжній брокер перевіряє kafka.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Db } from '../src/db/index.js';
import { InvalidEventError, parseEnvelope, type Envelope } from '../src/db/events.js';
import { handleAuditRecorded, handlers, handleSchoolRegistered } from '../src/domain/events.js';
import type { IncomingMessage, OutgoingMessage, Producer } from '../src/kafka/bus.js';
import { processMessage, runConsumer } from '../src/kafka/consumer.js';
import { relayOnce, startRelay } from '../src/kafka/relay.js';
import { cleanup, scheduleCleanup } from '../src/maint.js';
import { maintDb, newSchool, superDb, relayDb, testApp, type TestCtx } from './helpers.js';
import Fastify from 'fastify';

let ctx: TestCtx;
let relay: Db;
let maint: Db;
let owner: Db;
const log = Fastify({ logger: { level: 'silent' } }).log;

beforeAll(async () => {
  ctx = await testApp();
  relay = relayDb();
  maint = maintDb();
  owner = superDb();
});
afterAll(async () => {
  await ctx.close();
  await Promise.all([relay.destroy(), maint.destroy(), owner.destroy()]);
});

const envelope = (type: string, schoolId: string, data: Record<string, unknown>): Envelope => ({
  event_id: crypto.randomUUID(),
  type,
  schema_version: '1.0',
  source: 'test',
  time: '2026-11-09T10:00:00.000Z',
  correlation_id: 'corr-1',
  school_id: schoolId,
  data,
});

class MemoryProducer implements Producer {
  sent: OutgoingMessage[] = [];
  failNext = 0;
  async send(messages: OutgoingMessage[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('kafka недоступна');
    }
    this.sent.push(...messages);
  }
  async close() {}
}

const message = (topic: string, value: string): IncomingMessage & { committed: number } => {
  const m = {
    topic,
    partition: 0,
    offset: '42',
    key: 'k',
    value,
    committed: 0,
    async commit() {
      m.committed++;
    },
  };
  return m;
};

describe('school.registered', () => {
  test('порожній профіль з назвою, журнал «заклад зареєстровано», повтор пропускається', async () => {
    const school = newSchool();
    const e = envelope('school.registered', school, { school_id: school, name: 'Ліцей № 17', registered_at: '2026-11-09T09:00:00.000Z' });
    expect(await handleSchoolRegistered(ctx.db, e)).toBe('processed');
    expect(await handleSchoolRegistered(ctx.db, e)).toBe('duplicate');
    const profile = (await ctx.as(school, 'GET', '/school')).json();
    expect(profile).toMatchObject({ name: 'Ліцей № 17', snapshot_version: 0 });
    const audit = (await ctx.as(school, 'GET', '/audit?from=2026-11-01&to=2026-11-30')).json();
    expect(audit).toEqual([
      expect.objectContaining({ action: 'school_registered', actor: 'tenant-service', target: school, at: '2026-11-09T09:00:00.000Z' }),
    ]);
  });

  test('профіль, створений раніше, отримує назву без зміни версії', async () => {
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { lessons_per_day: 6 });
    await handleSchoolRegistered(ctx.db, envelope('school.registered', school, { name: 'Гімназія' }));
    expect((await ctx.as(school, 'GET', '/school')).json()).toMatchObject({ name: 'Гімназія', lessons_per_day: 6, snapshot_version: 1 });
  });

  test('без назви — InvalidEventError', async () => {
    await expect(handleSchoolRegistered(ctx.db, envelope('school.registered', newSchool(), {}))).rejects.toBeInstanceOf(InvalidEventError);
  });
});

describe('audit.recorded', () => {
  test('запис з подією timetable; повтор пропускається; чужий заклад не бачить', async () => {
    const school = newSchool();
    const target = crypto.randomUUID();
    const e = envelope('audit.recorded', school, { at: '2026-11-09T12:00:00.000Z', actor: 'demo', action: 'timetable_published', target, details: { timetable_id: target } });
    expect(await handleAuditRecorded(ctx.db, e)).toBe('processed');
    expect(await handleAuditRecorded(ctx.db, e)).toBe('duplicate');
    const audit = (await ctx.as(school, 'GET', '/audit?from=2026-11-09&to=2026-11-09')).json();
    expect(audit).toEqual([{ entry_id: expect.any(String), at: '2026-11-09T12:00:00.000Z', actor: 'demo', action: 'timetable_published', target, details: { timetable_id: target } }]);
    expect((await ctx.as(newSchool(), 'GET', '/audit?from=2026-11-09&to=2026-11-09')).json()).toEqual([]);
  });

  test('без action/actor або з поганою датою — InvalidEventError', async () => {
    const school = newSchool();
    await expect(handleAuditRecorded(ctx.db, envelope('audit.recorded', school, { actor: 'x' }))).rejects.toBeInstanceOf(InvalidEventError);
    await expect(handleAuditRecorded(ctx.db, envelope('audit.recorded', school, { actor: 'x', action: 'y', at: 'вчора' }))).rejects.toBeInstanceOf(InvalidEventError);
  });

  test('без target і details — null і {}', async () => {
    const school = newSchool();
    await handleAuditRecorded(ctx.db, envelope('audit.recorded', school, { actor: 'demo', action: 'qr_rotated' }));
    const [entry] = (await ctx.as(school, 'GET', '/audit?from=2026-11-09&to=2026-11-09')).json();
    expect(entry).toMatchObject({ target: null, details: {} });
  });
});

describe('конверт', () => {
  test.each([
    ['не JSON', '{'],
    ['не об’єкт', '42'],
    ['event_id не uuid', JSON.stringify({ event_id: 'x', school_id: crypto.randomUUID(), type: 't', schema_version: '1.0', data: {} })],
    ['school_id не uuid', JSON.stringify({ event_id: crypto.randomUUID(), school_id: 'x', type: 't', schema_version: '1.0', data: {} })],
    ['немає type', JSON.stringify({ event_id: crypto.randomUUID(), school_id: crypto.randomUUID(), schema_version: '1.0', data: {} })],
    ['невідомий MAJOR', JSON.stringify({ event_id: crypto.randomUUID(), school_id: crypto.randomUUID(), type: 't', schema_version: '2.0', data: {} })],
    ['немає data', JSON.stringify({ event_id: crypto.randomUUID(), school_id: crypto.randomUUID(), type: 't', schema_version: '1.0' })],
  ])('%s → InvalidEventError', (_n, raw) => {
    expect(() => parseEnvelope(raw)).toThrow(InvalidEventError);
  });

  test('мінорна версія й зайві поля приймаються, id у нижньому регістрі', () => {
    const id = crypto.randomUUID().toUpperCase();
    const e = parseEnvelope(JSON.stringify({ event_id: id, school_id: id, type: 't', schema_version: '1.3', data: {}, extra: true }));
    expect(e).toMatchObject({ event_id: id.toLowerCase(), school_id: id.toLowerCase(), source: 'unknown', correlation_id: id.toLowerCase() });
  });
});

describe('консюмер', () => {
  test('успішна обробка → commit, без DLQ', async () => {
    const producer = new MemoryProducer();
    const school = newSchool();
    const m = message('school.registered', JSON.stringify(envelope('school.registered', school, { name: 'Школа' })));
    expect(await processMessage(m, { db: ctx.db, producer, handlers, log })).toBe('processed');
    expect(m.committed).toBe(1);
    expect(producer.sent).toEqual([]);
  });

  test('технічна помилка: 3 спроби з паузою, далі DLQ з заголовками і commit', async () => {
    const producer = new MemoryProducer();
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('база недоступна');
    };
    const raw = JSON.stringify(envelope('audit.recorded', newSchool(), {}));
    const m = message('audit.recorded', raw);
    const res = await processMessage(m, { db: ctx.db, producer, handlers: { 'audit.recorded': failing }, log, backoffMs: () => 1 });
    expect(res).toBe('dlq');
    expect(calls).toBe(3);
    expect(m.committed).toBe(1);
    expect(producer.sent).toEqual([
      {
        topic: 'audit.recorded.dlq',
        key: 'k',
        value: raw,
        headers: { 'x-error': 'база недоступна', 'x-original-topic': 'audit.recorded', 'x-original-partition': '0', 'x-original-offset': '42' },
      },
    ]);
  });

  test('друга спроба вдалася — без DLQ', async () => {
    const producer = new MemoryProducer();
    let calls = 0;
    const flaky = async () => {
      if (++calls === 1) throw new Error('тимчасово');
    };
    const m = message('audit.recorded', JSON.stringify(envelope('audit.recorded', newSchool(), {})));
    expect(await processMessage(m, { db: ctx.db, producer, handlers: { 'audit.recorded': flaky }, log, backoffMs: () => 1 })).toBe('processed');
    expect(calls).toBe(2);
  });

  test('зламана подія чи невідомий топік — одразу DLQ, без повторів', async () => {
    const producer = new MemoryProducer();
    const bad = message('school.registered', 'не json');
    expect(await processMessage(bad, { db: ctx.db, producer, handlers, log })).toBe('dlq');
    const noName = message('school.registered', JSON.stringify(envelope('school.registered', newSchool(), {})));
    expect(await processMessage(noName, { db: ctx.db, producer, handlers, log, backoffMs: () => 1000 })).toBe('dlq');
    const unknown = message('mystery', JSON.stringify(envelope('mystery', newSchool(), {})));
    expect(await processMessage(unknown, { db: ctx.db, producer, handlers, log })).toBe('dlq');
    expect(producer.sent.map((s) => s.topic)).toEqual(['school.registered.dlq', 'school.registered.dlq', 'mystery.dlq']);
    expect([bad, noName, unknown].map((m) => m.committed)).toEqual([1, 1, 1]);
  });

  test('runConsumer проганяє всі повідомлення джерела по черзі', async () => {
    const producer = new MemoryProducer();
    const school = newSchool();
    const msgs = [
      message('school.registered', JSON.stringify(envelope('school.registered', school, { name: 'A' }))),
      message('audit.recorded', JSON.stringify(envelope('audit.recorded', school, { actor: 'demo', action: 'x' }))),
    ];
    await runConsumer(
      { run: async (on) => { for (const m of msgs) await on(m); }, close: async () => {} },
      { db: ctx.db, producer, handlers, log },
    );
    expect(msgs.map((m) => m.committed)).toEqual([1, 1]);
  });
});

describe('relay', () => {
  test('відправляє невідправлені події з ключем school_id і позначає їх', async () => {
    // Спершу відправляємо все, що накопичили інші тести, щоб далі рахувати лише свої події.
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { lessons_per_day: 5 });
    await ctx.as(school, 'PUT', '/school', { lessons_per_day: 6 });
    const producer = new MemoryProducer();
    expect(await relayOnce(relay, producer)).toBe(2);
    expect(producer.sent.map((m) => [m.topic, m.key, JSON.parse(m.value).data.snapshot_version])).toEqual([
      ['school.data.changed', school, 1],
      ['school.data.changed', school, 2],
    ]);
    expect(await relayOnce(relay, producer)).toBe(0);
  });

  test('Kafka не прийняла — рядки лишаються невідправленими', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { saturday: true });
    const producer = new MemoryProducer();
    producer.failNext = 1;
    await expect(relayOnce(relay, producer)).rejects.toThrow('kafka недоступна');
    expect(await relayOnce(relay, producer)).toBe(1);
  });

  test('startRelay працює у фоні й зупиняється', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const producer = new MemoryProducer();
    producer.failNext = 1;
    const handle = startRelay(relay, producer, log, 10);
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { saturday: true });
    for (let i = 0; i < 100 && producer.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await handle.stop();
    expect(producer.sent.some((m) => m.key === school)).toBe(true);
  });
});

describe('щоденна чистка (school_maint)', () => {
  test('журнал старший за рік, надіслані outbox і inbox старші за 7 днів', async () => {
    const school = newSchool();
    const old = new Date('2020-01-01T00:00:00Z');
    await owner.insertInto('audit_log').values([
      { school_id: school, entry_id: crypto.randomUUID(), actor: 'a', action: 'old', target: null, details: '{}', at: old },
      { school_id: school, entry_id: crypto.randomUUID(), actor: 'a', action: 'fresh', target: null, details: '{}' },
    ]).execute();
    await owner.insertInto('outbox').values([
      { school_id: school, event_id: crypto.randomUUID(), topic: 't', payload: '{}', published_at: old },
      { school_id: school, event_id: crypto.randomUUID(), topic: 't', payload: '{}', published_at: null },
    ]).execute();
    await owner.insertInto('inbox').values({ school_id: school, event_id: crypto.randomUUID(), topic: 't', received_at: old }).execute();

    const res = await cleanup(maint);
    expect(res.audit).toBeGreaterThanOrEqual(1);
    expect(res.outbox).toBeGreaterThanOrEqual(1);
    expect(res.inbox).toBeGreaterThanOrEqual(1);
    const left = await owner.selectFrom('audit_log').select('action').where('school_id', '=', school).execute();
    expect(left.map((l) => l.action)).toEqual(['fresh']);
    const outbox = await owner.selectFrom('outbox').select('published_at').where('school_id', '=', school).execute();
    expect(outbox).toEqual([{ published_at: null }]);
  });

  test('scheduleCleanup повертає функцію зупинки', () => {
    const stop = scheduleCleanup(maint, log);
    expect(typeof stop).toBe('function');
    stop();
  });
});
