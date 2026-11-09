// Класи, предмети, вчителі, план: створення, зміна, архівування, видалення й експорт вчителя,
// ізоляція закладів (чужий ресурс → 404).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { newSchool, seedSchool, testApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

describe('класи', () => {
  test('створення, список, зміна', async () => {
    const school = newSchool();
    const created = await ctx.as(school, 'POST', '/classes', { name: ' 5-А ', students: 28, in_person_priority: true });
    expect(created.statusCode).toBe(201);
    const cls = created.json();
    expect(cls).toMatchObject({ name: '5-А', students: 28, in_person_priority: true, archived_at: null });
    expect(cls.class_id).toMatch(/^[0-9a-f-]{36}$/);

    const updated = await ctx.as(school, 'PUT', `/classes/${cls.class_id}`, { name: '5-Б', students: 30, in_person_priority: false });
    expect(updated.json()).toMatchObject({ class_id: cls.class_id, name: '5-Б', students: 30, in_person_priority: false });
    expect((await ctx.as(school, 'GET', '/classes')).json()).toHaveLength(1);

    const events = await ctx.events(school);
    expect(events.map((e) => e.data.changes)).toEqual([
      [{ entity: 'class', op: 'created', id: cls.class_id }],
      [{ entity: 'class', op: 'updated', id: cls.class_id }],
    ]);
  });

  test('назва активного класу унікальна → 409 name_taken; після архівування вільна', async () => {
    const school = newSchool();
    const a = (await ctx.as(school, 'POST', '/classes', { name: '7-В', students: 20, in_person_priority: false })).json();
    const dup = await ctx.as(school, 'POST', '/classes', { name: '7-в', students: 20, in_person_priority: false });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'name_taken' });
    const b = (await ctx.as(school, 'POST', '/classes', { name: '7-Г', students: 20, in_person_priority: false })).json();
    expect((await ctx.as(school, 'PUT', `/classes/${b.class_id}`, { name: '7-В', students: 1, in_person_priority: false })).statusCode).toBe(409);
    expect((await ctx.as(school, 'DELETE', `/classes/${a.class_id}`)).statusCode).toBe(204);
    expect((await ctx.as(school, 'POST', '/classes', { name: '7-В', students: 20, in_person_priority: false })).statusCode).toBe(201);
  });

  test('архівування: рядки плану класу видаляються, повтор нічого не робить, зміна → 409', async () => {
    const school = newSchool();
    const { cls } = await seedSchool(ctx, school);
    expect((await ctx.as(school, 'DELETE', `/classes/${cls.class_id}`)).statusCode).toBe(204);
    expect((await ctx.as(school, 'GET', '/curriculum')).json()).toEqual([]);
    const listed = (await ctx.as(school, 'GET', '/classes')).json();
    expect(listed[0].archived_at).not.toBeNull();
    const before = (await ctx.events(school)).length;
    expect((await ctx.as(school, 'DELETE', `/classes/${cls.class_id}`)).statusCode).toBe(204);
    expect(await ctx.events(school)).toHaveLength(before);
    const last = (await ctx.events(school)).at(-1)!;
    expect(last.data.changes).toEqual([{ entity: 'class', op: 'archived', id: cls.class_id }, { entity: 'curriculum', op: 'updated' }]);
    const upd = await ctx.as(school, 'PUT', `/classes/${cls.class_id}`, { name: 'X', students: 1, in_person_priority: false });
    expect(upd.json()).toMatchObject({ code: 'archived' });
  });

  test('без змін — події немає; порожня назва → 400; не-uuid і чужий id → 404', async () => {
    const school = newSchool();
    const cls = (await ctx.as(school, 'POST', '/classes', { name: '1-А', students: 10, in_person_priority: false })).json();
    await ctx.as(school, 'PUT', `/classes/${cls.class_id}`, { name: '1-А', students: 10, in_person_priority: false });
    expect(await ctx.events(school)).toHaveLength(1);
    expect((await ctx.as(school, 'POST', '/classes', { name: '   ', students: 10, in_person_priority: false })).statusCode).toBe(400);
    expect((await ctx.as(school, 'PUT', '/classes/not-a-uuid', { name: 'A', students: 1, in_person_priority: false })).statusCode).toBe(404);
    const other = newSchool();
    expect((await ctx.as(other, 'PUT', `/classes/${cls.class_id}`, { name: 'A', students: 1, in_person_priority: false })).statusCode).toBe(404);
    expect((await ctx.as(other, 'DELETE', `/classes/${cls.class_id}`)).statusCode).toBe(404);
    expect((await ctx.as(other, 'GET', '/classes')).json()).toEqual([]);
  });

  test('учнів 0–60', async () => {
    expect((await ctx.as(newSchool(), 'POST', '/classes', { name: 'A', students: 61, in_person_priority: false })).statusCode).toBe(400);
  });
});

describe('предмети', () => {
  const math = { name: 'Математика', short_name: 'Мат', education_area: 'math', not_in_shelter: false };

  test('створення, зміна, невідома галузь → 400', async () => {
    const school = newSchool();
    const s = (await ctx.as(school, 'POST', '/subjects', math)).json();
    expect(s).toMatchObject({ ...math, archived_at: null });
    const upd = await ctx.as(school, 'PUT', `/subjects/${s.subject_id}`, { ...math, education_area: 'physical', not_in_shelter: true });
    expect(upd.json()).toMatchObject({ education_area: 'physical', not_in_shelter: true });
    expect((await ctx.as(school, 'POST', '/subjects', { ...math, education_area: 'magic' })).statusCode).toBe(400);
    expect((await ctx.as(school, 'POST', '/subjects', { ...math, name: '  ' })).statusCode).toBe(400);
    expect((await ctx.as(school, 'PUT', `/subjects/${s.subject_id}`, { ...math, education_area: 'physical', not_in_shelter: true })).statusCode).toBe(200);
    expect(await ctx.events(school)).toHaveLength(2);
  });

  test('архівування: 409 in_curriculum, якщо предмет у плані; інакше 204 і повтор без події', async () => {
    const school = newSchool();
    const { subj } = await seedSchool(ctx, school);
    const res = await ctx.as(school, 'DELETE', `/subjects/${subj.subject_id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'in_curriculum' });
    await ctx.as(school, 'PUT', '/curriculum', []);
    expect((await ctx.as(school, 'DELETE', `/subjects/${subj.subject_id}`)).statusCode).toBe(204);
    const n = (await ctx.events(school)).length;
    expect((await ctx.as(school, 'DELETE', `/subjects/${subj.subject_id}`)).statusCode).toBe(204);
    expect(await ctx.events(school)).toHaveLength(n);
    expect((await ctx.as(school, 'PUT', `/subjects/${subj.subject_id}`, math)).json()).toMatchObject({ code: 'archived' });
    expect((await ctx.as(newSchool(), 'DELETE', `/subjects/${subj.subject_id}`)).statusCode).toBe(404);
    expect((await ctx.as(newSchool(), 'PUT', `/subjects/${subj.subject_id}`, math)).statusCode).toBe(404);
  });
});

describe('вчителі', () => {
  const t = (label: string) => ({ label, weekly_hours_limit: 18, unavailable_days: [5, 1, 5] });

  test('teacher_no зростає в межах закладу, дні сортуються й без повторів', async () => {
    const school = newSchool();
    const a = (await ctx.as(school, 'POST', '/teachers', t('Іваненко О. П.'))).json();
    const b = (await ctx.as(school, 'POST', '/teachers', t('Математика-1'))).json();
    expect(a).toMatchObject({ teacher_no: 1, label: 'Іваненко О. П.', unavailable_days: [1, 5], deleted_at: null });
    expect(b.teacher_no).toBe(2);
    expect((await ctx.as(newSchool(), 'POST', '/teachers', t('Інший'))).json().teacher_no).toBe(1);
  });

  test('паралельне створення не дає однакових teacher_no', async () => {
    const school = newSchool();
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => ctx.as(school, 'POST', '/teachers', t(`Вч-${i}`))));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(res.map((r) => r.json().teacher_no)).size).toBe(5);
  });

  test('підпис унікальний → 409 label_taken; «Вчитель #N» зарезервовано → 400', async () => {
    const school = newSchool();
    await ctx.as(school, 'POST', '/teachers', t('Петренко'));
    const dup = await ctx.as(school, 'POST', '/teachers', t('Петренко'));
    expect(dup.json()).toMatchObject({ code: 'label_taken' });
    expect((await ctx.as(school, 'POST', '/teachers', t('Вчитель #3'))).statusCode).toBe(400);
    expect((await ctx.as(school, 'POST', '/teachers', t('  '))).statusCode).toBe(400);
    const other = (await ctx.as(school, 'POST', '/teachers', t('Сидоренко'))).json();
    expect((await ctx.as(school, 'PUT', `/teachers/${other.teacher_id}`, t('Петренко'))).statusCode).toBe(409);
  });

  test('зміна і зміна без різниці', async () => {
    const school = newSchool();
    const a = (await ctx.as(school, 'POST', '/teachers', t('Коваль'))).json();
    const upd = await ctx.as(school, 'PUT', `/teachers/${a.teacher_id}`, { label: 'Коваль І.', weekly_hours_limit: 10, unavailable_days: [] });
    expect(upd.json()).toMatchObject({ label: 'Коваль І.', weekly_hours_limit: 10, unavailable_days: [] });
    await ctx.as(school, 'PUT', `/teachers/${a.teacher_id}`, { label: 'Коваль І.', weekly_hours_limit: 10, unavailable_days: [] });
    expect(await ctx.events(school)).toHaveLength(2);
    expect((await ctx.as(newSchool(), 'PUT', `/teachers/${a.teacher_id}`, t('X'))).statusCode).toBe(404);
  });

  test('видалення (ст. 15): 409 якщо в плані; далі «Вчитель #N», подія з teacher_no, підпис знову вільний', async () => {
    const school = newSchool();
    const { teacher } = await seedSchool(ctx, school);
    const blocked = await ctx.as(school, 'DELETE', `/teachers/${teacher.teacher_id}`);
    expect(blocked.json()).toMatchObject({ code: 'in_curriculum' });
    await ctx.as(school, 'PUT', '/curriculum', []);
    expect((await ctx.as(school, 'DELETE', `/teachers/${teacher.teacher_id}`)).statusCode).toBe(204);
    const listed = (await ctx.as(school, 'GET', '/teachers')).json();
    expect(listed[0]).toMatchObject({ teacher_id: teacher.teacher_id, label: 'Вчитель #1', unavailable_days: [] });
    expect(listed[0].deleted_at).not.toBeNull();
    const last = (await ctx.events(school)).at(-1)!;
    expect(last.data.changes).toEqual([{ entity: 'teacher', op: 'deleted', id: teacher.teacher_id, teacher_no: 1 }]);
    expect(JSON.stringify(last)).not.toContain('Іваненко');
    expect((await ctx.as(school, 'PUT', `/teachers/${teacher.teacher_id}`, t('Нове'))).json()).toMatchObject({ code: 'deleted' });
    expect((await ctx.as(school, 'DELETE', `/teachers/${teacher.teacher_id}`)).statusCode).toBe(204);
    expect((await ctx.as(school, 'POST', '/teachers', t('Іваненко О. П.'))).json().teacher_no).toBe(2);
    expect((await ctx.as(newSchool(), 'DELETE', `/teachers/${teacher.teacher_id}`)).statusCode).toBe(404);
  });

  test('експорт (ст. 8): дані, план, журнал; сам експорт пишеться в журнал', async () => {
    const school = newSchool();
    const { teacher, cls, subj } = await seedSchool(ctx, school);
    const res = await ctx.as(school, 'GET', `/teachers/${teacher.teacher_id}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      source: 'school-service',
      teacher: { teacher_id: teacher.teacher_id, label: 'Іваненко О. П.' },
      curriculum: [{ class_id: cls.class_id, class_name: '5-А', subject_id: subj.subject_id, subject_name: 'Математика', hours_per_week: 4 }],
    });
    expect(body.audit.map((a: { action: string }) => a.action)).toEqual(['teacher_created']);
    const again = (await ctx.as(school, 'GET', `/teachers/${teacher.teacher_id}/export`)).json();
    expect(again.audit.map((a: { action: string }) => a.action)).toEqual(['teacher_created', 'teacher_exported']);
    expect((await ctx.as(newSchool(), 'GET', `/teachers/${teacher.teacher_id}/export`)).statusCode).toBe(404);
  });
});

describe('навчальний план', () => {
  test('PUT замінює цілком; GET повертає', async () => {
    const school = newSchool();
    const { cls, subj, teacher } = await seedSchool(ctx, school);
    const rows = (await ctx.as(school, 'GET', '/curriculum')).json();
    expect(rows).toEqual([{ class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 4 }]);
    const last = (await ctx.events(school)).at(-1)!;
    expect(last.data.changes).toEqual([{ entity: 'curriculum', op: 'replaced' }]);
  });

  test('повтор пари клас × предмет → 400', async () => {
    const school = newSchool();
    const { cls, subj, teacher } = await seedSchool(ctx, school);
    const row = { class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 2 };
    expect((await ctx.as(school, 'PUT', '/curriculum', [row, row])).statusCode).toBe(400);
  });

  test('посилання на чужі, архівовані чи неіснуючі дані → 422 unknown_reference, план не змінюється', async () => {
    const school = newSchool();
    const { cls, subj, teacher } = await seedSchool(ctx, school);
    const foreign = await seedSchool(ctx, newSchool());
    const bad = [
      { class_id: foreign.cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 1 },
      { class_id: cls.class_id, subject_id: foreign.subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 1 },
      { class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: crypto.randomUUID(), hours_per_week: 1 },
    ];
    for (const row of bad) {
      const res = await ctx.as(school, 'PUT', '/curriculum', [row]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'unknown_reference' });
    }
    expect((await ctx.as(school, 'GET', '/curriculum')).json()).toHaveLength(1);
  });

  test('годин 1–60, id лише uuid', async () => {
    const school = newSchool();
    const { cls, subj, teacher } = await seedSchool(ctx, school);
    expect((await ctx.as(school, 'PUT', '/curriculum', [{ class_id: cls.class_id, subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 0 }])).statusCode).toBe(400);
    expect((await ctx.as(school, 'PUT', '/curriculum', [{ class_id: 'x', subject_id: subj.subject_id, teacher_id: teacher.teacher_id, hours_per_week: 1 }])).statusCode).toBe(400);
  });
});
