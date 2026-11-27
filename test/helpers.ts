// Помічники тестів: власні ключі для підписаних токенів, застосунок, доступ до outbox і журналу.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { inject } from 'vitest';
import { buildApp, LOG_REDACT } from '../src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../src/auth.js';
import { createDb, type Db } from '../src/db/index.js';
import type { Envelope } from '../src/db/events.js';

export const ISSUER = 'http://localhost/idp/realms/lad';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export async function createTestTokens() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const verifyToken: TokenVerifier = createTokenVerifier({ issuer: ISSUER, clientId: 'web', keys: createLocalJWKSet({ keys: [jwk] }) });

  async function sign(
    claims: Record<string, unknown>,
    { issuer = ISSUER, expiresIn = '15m', key = privateKey }: { issuer?: string; expiresIn?: string | number; key?: PrivateKey } = {},
  ) {
    return new SignJWT({ azp: 'web', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(key);
  }

  return {
    verifyToken,
    sign,
    sysadmin: () => sign({ preferred_username: 'sysadmin', realm_access: { roles: ['sysadmin'] } }),
    scheduler: (schoolId: string, username = 'demo') =>
      sign({ preferred_username: username, school_id: schoolId, realm_access: { roles: ['scheduler'] } }),
  };
}

export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: { level: 'debug', stream, redact: LOG_REDACT } };
}

export const appDb = (): Db => createDb(inject('pg').app, 4);
export const relayDb = (): Db => createDb(inject('pg').relay, 2);
export const maintDb = (): Db => createDb(inject('pg').maint, 2);

/** Суперкористувач у тестовій базі: лише для підготовки даних в обхід RLS (наприклад, старі дати). */
export function superDb(): Db {
  const { admin, owner } = inject('pg');
  const url = new URL(admin);
  url.pathname = new URL(owner).pathname;
  return createDb(url.toString(), 1);
}

export const newSchool = () => crypto.randomUUID();

export async function testApp() {
  const tokens = await createTestTokens();
  const db = appDb();
  const relay = relayDb();
  const logs = captureLogs();
  const app = buildApp({ db, verifyToken: tokens.verifyToken, logger: logs.logger });
  await app.ready();

  /** Запит від імені укладача закладу schoolId. */
  async function as(schoolId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url: `/api/v1/school${url}`,
      headers: { authorization: `Bearer ${await tokens.scheduler(schoolId)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  /** Події закладу в outbox (читає роль relay: у app немає SELECT на outbox). */
  async function events(schoolId: string, topic = 'school.data.changed'): Promise<Envelope[]> {
    const rows = await relay
      .selectFrom('outbox')
      .select(['payload'])
      .where('school_id', '=', schoolId)
      .where('topic', '=', topic)
      .orderBy('created_at')
      .execute();
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Envelope);
  }

  async function close() {
    try {
      await checkOutgoingEvents(relay);
    } finally {
      await app.close();
      await db.destroy();
      await relay.destroy();
    }
  }

  return { app, db, tokens, logs, as, events, close };
}

export type TestCtx = Awaited<ReturnType<typeof testApp>>;

/** Заповнює заклад мінімальними даними: клас, предмет, вчитель, рядок плану. */
export async function seedSchool(ctx: TestCtx, schoolId: string) {
  const cls = (await ctx.as(schoolId, 'POST', '/classes', { name: '5-А', students: 28, in_person_priority: true })).json();
  const subj = (
    await ctx.as(schoolId, 'POST', '/subjects', { name: 'Математика', short_name: 'Мат', education_area: 'math', not_in_shelter: false })
  ).json();
  const teacher = (await ctx.as(schoolId, 'POST', '/teachers', { label: 'Іваненко О. П.', weekly_hours_limit: 20, unavailable_days: [] })).json();
  await ctx.as(schoolId, 'PUT', '/curriculum', [
    { class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 4 },
  ]);
  return { cls, subj, teacher };
}

/**
 * Кожна school.data.changed, яку сервіс поклав в outbox (source = school-service), відповідає схемі
 * contracts. Викликається при закритті тестового застосунку, тож перевіряє все, що записав файл тестів.
 * Рядки, вставлені тестами напряму (без source), не перевіряються.
 */
async function checkOutgoingEvents(relay: Db): Promise<void> {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@lad/contracts/package.json')), 'schemas', 'events');
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const validate = ajv.getSchema('https://lad.example/contracts/schemas/events/school.data.changed.v1.json')!;
  const rows = await relay.selectFrom('outbox').select(['payload']).where('topic', '=', 'school.data.changed').execute();
  const failures: string[] = [];
  for (const r of rows) {
    const event = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Envelope;
    if (event.source !== 'school-service') continue;
    if (!validate(event)) failures.push(`${JSON.stringify(event.data).slice(0, 200)}: ${JSON.stringify(validate.errors?.slice(0, 2))}`);
  }
  if (failures.length > 0) throw new Error(`school.data.changed не за схемою contracts (${failures.length}):\n${failures.slice(0, 5).join('\n')}`);
}
