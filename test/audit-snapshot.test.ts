// Журнал дій (період за Europe/Kyiv, фільтр за особою) і внутрішній знімок для timetable-service.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'kysely';
import type { Db } from '../src/db/index.js';
import { buildInternalApp } from '../src/internal.js';
import { captureLogs, newSchool, seedSchool, superDb, testApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let owner: Db;
beforeAll(async () => {
  ctx = await testApp();
  owner = superDb();
});
afterAll(async () => {
  await ctx.close();
  await owner.destroy();
});

describe('журнал', () => {
  test('від нових до старих; фільтр target; межі періоду за Києвом', async () => {
    const school = newSchool();
    const { cls, teacher } = await seedSchool(ctx, school);
    const all = (await ctx.as(school, 'GET', '/audit?from=2000-01-01&to=2100-12-31')).json();
    expect(all.map((a: { action: string }) => a.action)).toEqual(['curriculum_replaced', 'teacher_created', 'subject_created', 'class_created']);
    const byTeacher = (await ctx.as(school, 'GET', `/audit?from=2000-01-01&to=2100-12-31&target=${teacher.teacher_id}`)).json();
    expect(byTeacher).toHaveLength(1);
    expect(byTeacher[0]).toMatchObject({ action: 'teacher_created', actor: 'demo', target: teacher.teacher_id, details: {} });

    // 2026-03-09 23:30 за Києвом (UTC+2) — це ще 9 березня, хоча в UTC 21:30.
    await owner
      .insertInto('audit_log')
      .values({ school_id: school, entry_id: crypto.randomUUID(), actor: 'x', action: 'late', target: cls.class_id, details: '{}', at: new Date('2026-03-09T21:30:00Z') })
      .execute();
    const day = (await ctx.as(school, 'GET', '/audit?from=2026-03-09&to=2026-03-09')).json();
    expect(day.map((a: { action: string }) => a.action)).toEqual(['late']);
    expect((await ctx.as(school, 'GET', '/audit?from=2026-03-10&to=2026-03-10')).json()).toEqual([]);
  });

  test('період обов’язковий і коректний', async () => {
    const school = newSchool();
    expect((await ctx.as(school, 'GET', '/audit')).statusCode).toBe(400);
    expect((await ctx.as(school, 'GET', '/audit?from=2026-11-10&to=2026-11-01')).statusCode).toBe(400);
    expect((await ctx.as(school, 'GET', '/audit?from=2026-13-40&to=2026-11-01')).statusCode).toBe(400);
    expect((await ctx.as(school, 'GET', '/audit?from=2026-01-01&to=2026-02-01&target=abc')).statusCode).toBe(400);
  });

  test('журнал не змінюється: у school_app немає UPDATE і DELETE', async () => {
    const school = newSchool();
    await seedSchool(ctx, school);
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await sql`select set_config('app.school_id', ${school}, true)`.execute(trx);
        await trx.deleteFrom('audit_log').execute();
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('знімок /internal/v1/schools/{id}/snapshot', () => {
  test('повні дані з snapshot_version, зокрема архівні; без токена', async () => {
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { lessons_per_day: 7, shelter_capacity: 100, non_teaching_staff: 5, shelter_seats: 80 });
    await ctx.as(school, 'PUT', '/bells', [{ lesson_no: 1, start: '08:30', end: '09:15' }]);
    const { cls, subj, teacher } = await seedSchool(ctx, school);
    const extra = (await ctx.as(school, 'POST', '/classes', { name: '9-Б', students: 25, in_person_priority: false })).json();
    await ctx.as(school, 'DELETE', `/classes/${extra.class_id}`);

    const internal = buildInternalApp({ db: ctx.db, logger: captureLogs().logger });
    const res = await internal.inject({ method: 'GET', url: `/internal/v1/schools/${school}/snapshot` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const snap = res.json();
    const profile = (await ctx.as(school, 'GET', '/school')).json();
    expect(snap).toMatchObject({
      school_id: school,
      snapshot_version: profile.snapshot_version,
      profile: { name: '', lessons_per_day: 7, saturday: false, shelter_capacity: 100, non_teaching_staff: 5, shelter_seats: 80 },
      bells: [{ lesson_no: 1, start: '08:30', end: '09:15' }],
      subjects: [{ subject_id: subj.subject_id, education_area: 'math' }],
      teachers: [{ teacher_id: teacher.teacher_id, teacher_no: 1, label: 'Іваненко О. П.' }],
      curriculum: [{ class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 4 }],
    });
    expect(snap.snapshot_version).toBe(8);
    expect(snap.classes.map((c: { class_id: string; archived_at: string | null }) => [c.class_id, c.archived_at === null])).toEqual([
      [cls.class_id, true],
      [extra.class_id, false],
    ]);
    await internal.close();
  });

  test('заклад без даних — порожній знімок з версією 0; не-uuid → 404', async () => {
    const internal = buildInternalApp({ db: ctx.db, logger: captureLogs().logger });
    const school = newSchool();
    const res = await internal.inject({ method: 'GET', url: `/internal/v1/schools/${school}/snapshot` });
    expect(res.json()).toMatchObject({ school_id: school, snapshot_version: 0, profile: { lessons_per_day: null }, classes: [], curriculum: [] });
    expect((await internal.inject({ method: 'GET', url: '/internal/v1/schools/abc/snapshot' })).statusCode).toBe(404);
    expect((await internal.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    await internal.close();
  });

  test('знімок одного закладу не містить даних іншого', async () => {
    const a = newSchool();
    await seedSchool(ctx, a);
    const internal = buildInternalApp({ db: ctx.db, logger: captureLogs().logger });
    const res = await internal.inject({ method: 'GET', url: `/internal/v1/schools/${newSchool()}/snapshot` });
    expect(res.json().classes).toEqual([]);
    await internal.close();
  });
});
