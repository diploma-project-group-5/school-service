// Профіль закладу й дзвінки: порожній профіль до реєстрації, часткове оновлення, snapshot_version,
// подія school.data.changed і запис журналу в тій самій транзакції.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { newSchool, testApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

describe('профіль', () => {
  test('до school.registered — 200 з порожнім профілем', async () => {
    const res = await ctx.as(newSchool(), 'GET', '/school');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: '',
      lessons_per_day: null,
      saturday: false,
      shelter_capacity: null,
      non_teaching_staff: null,
      shelter_seats: null,
      snapshot_version: 0,
    });
  });

  test('часткове оновлення: версія +1, подія й журнал', async () => {
    const school = newSchool();
    const res = await ctx.as(school, 'PUT', '/school', { lessons_per_day: 7, shelter_capacity: 120 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lessons_per_day: 7, shelter_capacity: 120, saturday: false, snapshot_version: 1 });

    const second = await ctx.as(school, 'PUT', '/school', { saturday: true, non_teaching_staff: 6, shelter_seats: 90 });
    expect(second.json()).toMatchObject({ lessons_per_day: 7, saturday: true, non_teaching_staff: 6, shelter_seats: 90, snapshot_version: 2 });

    const events = await ctx.events(school);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'school.data.changed',
      schema_version: '1.0',
      source: 'school-service',
      school_id: school,
      data: { snapshot_version: 2, changes: [{ entity: 'profile', op: 'updated' }] },
    });
    expect(events[1]!.correlation_id).toBeTruthy();

    const audit = await ctx.as(school, 'GET', `/audit?from=2000-01-01&to=2100-01-01`);
    expect(audit.json().map((a: { action: string }) => a.action)).toEqual(['profile_updated', 'profile_updated']);
    expect(audit.json()[0]).toMatchObject({ actor: 'demo', target: school, details: { fields: ['saturday', 'non_teaching_staff', 'shelter_seats'] } });
  });

  test('без змін — версія не росте, події немає', async () => {
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { lessons_per_day: 6 });
    const res = await ctx.as(school, 'PUT', '/school', { lessons_per_day: 6, name: 'ігнорується', snapshot_version: 99 });
    expect(res.json()).toMatchObject({ snapshot_version: 1, name: '' });
    expect(await ctx.events(school)).toHaveLength(1);
  });

  test('скидання поля в null дозволене', async () => {
    const school = newSchool();
    await ctx.as(school, 'PUT', '/school', { shelter_seats: 50 });
    const res = await ctx.as(school, 'PUT', '/school', { shelter_seats: null });
    expect(res.json()).toMatchObject({ shelter_seats: null, snapshot_version: 2 });
  });

  test('валідація: уроків на день 1–10, невідомі поля, від’ємні значення', async () => {
    const school = newSchool();
    for (const body of [{ lessons_per_day: 0 }, { lessons_per_day: 11 }, { shelter_capacity: -1 }, { foo: 1 }, { saturday: 'yes' }]) {
      const res = await ctx.as(school, 'PUT', '/school', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('дзвінки', () => {
  const bells = [
    { lesson_no: 1, start: '08:30', end: '09:15' },
    { lesson_no: 2, start: '09:25', end: '10:10' },
  ];

  test('PUT замінює розклад, GET повертає за номером', async () => {
    const school = newSchool();
    const res = await ctx.as(school, 'PUT', '/bells', [bells[1], bells[0]]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(bells);
    expect((await ctx.as(school, 'GET', '/bells')).json()).toEqual(bells);
    const replaced = await ctx.as(school, 'PUT', '/bells', [bells[0]]);
    expect(replaced.json()).toEqual([bells[0]]);
    const events = await ctx.events(school);
    expect(events.map((e) => e.data)).toEqual([
      { snapshot_version: 1, changes: [{ entity: 'bells', op: 'replaced' }] },
      { snapshot_version: 2, changes: [{ entity: 'bells', op: 'replaced' }] },
    ]);
  });

  test('порожній список дозволений', async () => {
    expect((await ctx.as(newSchool(), 'PUT', '/bells', [])).json()).toEqual([]);
  });

  test.each([
    ['повтор номера', [bells[0], { ...bells[1], lesson_no: 1 }]],
    ['кінець раніше початку', [{ lesson_no: 1, start: '09:15', end: '08:30' }]],
    ['перетин уроків', [bells[0], { lesson_no: 2, start: '09:00', end: '09:40' }]],
    ['поганий формат часу', [{ lesson_no: 1, start: '8:30', end: '09:15' }]],
    ['номер поза 1–10', [{ lesson_no: 11, start: '08:30', end: '09:15' }]],
  ])('%s → 400', async (_name, body) => {
    const res = await ctx.as(newSchool(), 'PUT', '/bells', body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });
});
