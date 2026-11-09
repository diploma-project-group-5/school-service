// Ролі й ізоляція в базі school (розділ 03): заклад A не бачить рядків закладу B; у ролях app,
// relay і maint немає BYPASSRLS; relay і maint бачять рядки всіх закладів лише у своїх таблицях,
// а в інших — нічого; FORCE RLS на кожній таблиці; міграції up/down.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createDb, withSchool, type Db } from '../src/db/index.js';
import { createMigrator, migrateToLatest } from '../src/db/migrations.js';
import { maintDb, newSchool, relayDb, seedSchool, testApp, type TestCtx } from './helpers.js';

const urls = inject('pg');
let ctx: TestCtx;
let relay: Db;
let maint: Db;
const schoolA = newSchool();
const schoolB = newSchool();

const TABLES = ['school_profile', 'bells', 'classes', 'subjects', 'teachers', 'curriculum', 'audit_log', 'outbox', 'inbox'];

beforeAll(async () => {
  ctx = await testApp();
  relay = relayDb();
  maint = maintDb();
  await seedSchool(ctx, schoolA);
  await seedSchool(ctx, schoolB);
});
afterAll(async () => {
  await ctx.close();
  await Promise.all([relay.destroy(), maint.destroy()]);
});

describe('ізоляція закладів у school_app', () => {
  test('у транзакції закладу A видно лише рядки A в кожній таблиці', async () => {
    await withSchool(ctx.db, schoolA, async (trx) => {
      for (const table of ['school_profile', 'classes', 'subjects', 'teachers', 'curriculum', 'audit_log']) {
        const rows = await sql<{ school_id: string }>`select distinct school_id from ${sql.raw(table)}`.execute(trx);
        expect(rows.rows.map((r) => r.school_id), table).toEqual([schoolA]);
      }
    });
  });

  test('без app.school_id — 0 рядків', async () => {
    const rows = await ctx.db.selectFrom('classes').selectAll().execute();
    expect(rows).toEqual([]);
  });

  test('запис рядка чужого закладу відхиляє RLS', async () => {
    await expect(
      withSchool(ctx.db, schoolA, (trx) =>
        trx.insertInto('classes').values({ school_id: schoolB, class_id: crypto.randomUUID(), name: 'X', students: 1, in_person_priority: false }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test('school_app не читає outbox і не змінює схему', async () => {
    await expect(withSchool(ctx.db, schoolA, (trx) => trx.selectFrom('outbox').selectAll().execute())).rejects.toThrow(/permission denied/);
    await expect(sql`create table hack (id int)`.execute(ctx.db)).rejects.toThrow(/permission denied/);
  });
});

describe('relay і maint', () => {
  test('relay бачить outbox усіх закладів', async () => {
    const rows = await relay.selectFrom('outbox').select('school_id').where('school_id', 'in', [schoolA, schoolB]).groupBy('school_id').execute();
    expect(rows).toHaveLength(2);
  });

  test('relay не має доступу до інших таблиць', async () => {
    for (const table of TABLES.filter((t) => t !== 'outbox')) {
      await expect(sql`select 1 from ${sql.raw(table)} limit 1`.execute(relay), table).rejects.toThrow(/permission denied/);
    }
  });

  test('maint бачить outbox, inbox і журнал усіх закладів, але не дані закладу', async () => {
    const audit = await maint.selectFrom('audit_log').select('school_id').where('school_id', 'in', [schoolA, schoolB]).groupBy('school_id').execute();
    expect(audit).toHaveLength(2);
    for (const table of ['school_profile', 'bells', 'classes', 'subjects', 'teachers', 'curriculum']) {
      await expect(sql`select 1 from ${sql.raw(table)} limit 1`.execute(maint), table).rejects.toThrow(/permission denied/);
    }
    await expect(maint.insertInto('outbox').values({ school_id: schoolA, event_id: crypto.randomUUID(), topic: 't', payload: '{}' }).execute()).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('ролі й таблиці', () => {
  test('у ролях немає SUPERUSER і BYPASSRLS', async () => {
    const rows = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      select rolname, rolsuper, rolbypassrls from pg_roles
      where rolname in ('school_app', 'school_relay', 'school_maint', 'school_owner')`.execute(ctx.db);
    expect(rows.rows).toHaveLength(4);
    for (const r of rows.rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  test('FORCE ROW LEVEL SECURITY на кожній таблиці; school_id — перша колонка первинного ключа', async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace and relname <> 'kysely_migration' and relname <> 'kysely_migration_lock'
      order by relname`.execute(ctx.db);
    expect(rls.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rls.rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

    const pk = await sql<{ table: string; first: string }>`
      select c.relname as table, a.attname as first
      from pg_index i join pg_class c on c.oid = i.indrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indisprimary and c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES})`.execute(ctx.db);
    expect(pk.rows).toHaveLength(TABLES.length);
    for (const r of pk.rows) expect(r.first, r.table).toBe('school_id');
  });
});

describe('міграції', () => {
  const ownerFor = (db: string) => {
    const u = new URL(urls.owner);
    u.pathname = `/${db}`;
    return new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: u.toString(), max: 1 }) }) });
  };

  test('на чистій базі: up, down, знову up', async () => {
    const db = `school_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER school_owner`);
    const owner = ownerFor(db);
    try {
      expect(await migrateToLatest(owner)).toEqual(['0001_school_data']);
      const down = await createMigrator(owner).migrateDown();
      expect(down.error).toBeUndefined();
      const left = await sql<{ n: number }>`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename not like 'kysely%'`.execute(owner);
      expect(left.rows[0]?.n).toBe(0);
      expect(await migrateToLatest(owner)).toEqual(['0001_school_data']);
    } finally {
      await owner.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('помилка міграції не ковтається (school_app не може створювати таблиці)', async () => {
    const db = `school_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER school_owner`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO school_app`);
    const u = new URL(urls.app);
    u.pathname = `/${db}`;
    const asApp = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: u.toString(), max: 1 }) }) });
    try {
      await expect(migrateToLatest(asApp)).rejects.toThrow();
    } finally {
      await asApp.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('повторний запуск нічого не робить', async () => {
    const owner = createDb(urls.owner, 1) as unknown as Kysely<unknown>;
    try {
      expect(await migrateToLatest(owner)).toEqual([]);
    } finally {
      await owner.destroy();
    }
  });
});
