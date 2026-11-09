// Вчителі (розділ 09) і права вчителя за Законом № 2297-VI (етап 2): видалення даних (ст. 15)
// і експорт (ст. 8). Мінімум ПД: лише підпис, тижневий ліміт і недоступні дні.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withSchool, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { bumpSnapshotVersion, isUniqueViolation, recordChange, writeAudit, type Ctx } from './changes.js';

export type Day = 1 | 2 | 3 | 4 | 5 | 6;

export interface Teacher {
  teacher_id: string;
  teacher_no: number;
  /** Підпис; після видалення — «Вчитель #N». */
  label: string;
  weekly_hours_limit: number;
  unavailable_days: Day[];
  deleted_at: string | null;
}
export type TeacherInput = Pick<Teacher, 'label' | 'weekly_hours_limit' | 'unavailable_days'>;

export const deletedLabel = (teacherNo: number) => `Вчитель #${teacherNo}`;

export const toTeacher = (r: {
  teacher_id: string;
  teacher_no: number;
  label: string | null;
  weekly_hours_limit: number;
  unavailable_days: number[];
  deleted_at: Date | null;
}): Teacher => ({
  teacher_id: r.teacher_id,
  teacher_no: r.teacher_no,
  label: r.label ?? deletedLabel(r.teacher_no),
  weekly_hours_limit: r.weekly_hours_limit,
  unavailable_days: [...r.unavailable_days].sort((a, b) => a - b) as Day[],
  deleted_at: r.deleted_at?.toISOString() ?? null,
});

export async function readTeachers(trx: Trx): Promise<Teacher[]> {
  const rows = await trx.selectFrom('teachers').selectAll().orderBy('deleted_at', (ob) => ob.desc().nullsFirst()).orderBy('teacher_no').execute();
  return rows.map(toTeacher);
}

export const listTeachers = (db: Db, schoolId: string) => withSchool(db, schoolId, readTeachers);

function cleanTeacher(input: TeacherInput): TeacherInput {
  const label = input.label.trim();
  if (!label) fail(400, 'validation_failed', 'Некоректний підпис', 'Підпис вчителя не може бути порожнім');
  if (/^Вчитель #\d+$/.test(label)) {
    fail(400, 'validation_failed', 'Некоректний підпис', '«Вчитель #N» зарезервовано для видалених вчителів');
  }
  const days = [...new Set(input.unavailable_days)].sort((a, b) => a - b) as Day[];
  return { label, weekly_hours_limit: input.weekly_hours_limit, unavailable_days: days };
}

const labelTaken = (label: string) => fail(409, 'label_taken', 'Підпис зайнятий', `Вчитель з підписом «${label}» уже є`);

export async function createTeacher(db: Db, ctx: Ctx, input: TeacherInput): Promise<Teacher> {
  const t = cleanTeacher(input);
  try {
    return await withSchool(db, ctx.schoolId, async (trx) => {
      // Блокування рядка профілю робить max(teacher_no) + 1 безпечним при паралельних запитах.
      const version = await bumpSnapshotVersion(trx, ctx.schoolId);
      const { next } = await trx
        .selectFrom('teachers')
        .select(sql<number>`coalesce(max(teacher_no), 0) + 1`.as('next'))
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('teachers')
        .values({ school_id: ctx.schoolId, teacher_id: randomUUID(), teacher_no: next, ...t })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordChange(trx, ctx, version, [{ entity: 'teacher', op: 'created', id: row.teacher_id }], [
        { action: 'teacher_created', target: row.teacher_id },
      ]);
      return toTeacher(row);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'teachers_active_label')) labelTaken(t.label);
    throw err;
  }
}

export async function updateTeacher(db: Db, ctx: Ctx, teacherId: string, input: TeacherInput): Promise<Teacher> {
  const t = cleanTeacher(input);
  try {
    return await withSchool(db, ctx.schoolId, async (trx) => {
      const version = await bumpSnapshotVersion(trx, ctx.schoolId);
      const current = await trx.selectFrom('teachers').selectAll().where('teacher_id', '=', teacherId).executeTakeFirst();
      if (!current) return fail(404, 'not_found', 'Вчителя не знайдено');
      if (current.deleted_at) fail(409, 'deleted', 'Дані вчителя видалено', 'Видаленого вчителя змінити не можна');
      const before = toTeacher(current);
      const fields = (['label', 'weekly_hours_limit', 'unavailable_days'] as const).filter((f) =>
        f === 'unavailable_days' ? before.unavailable_days.join(',') !== t.unavailable_days.join(',') : before[f] !== t[f],
      );
      if (fields.length === 0) return before;
      const row = await trx.updateTable('teachers').set(t).where('teacher_id', '=', teacherId).returningAll().executeTakeFirstOrThrow();
      await recordChange(trx, ctx, version, [{ entity: 'teacher', op: 'updated', id: teacherId }], [
        { action: 'teacher_updated', target: teacherId, details: { fields } },
      ]);
      return toTeacher(row);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'teachers_active_label')) labelTaken(t.label);
    throw err;
  }
}

/**
 * Етап 2 · видалення даних вчителя (ст. 15): підпис і недоступні дні стираються, лишається
 * teacher_no — в історії «Вчитель #N». id іде в school.data.changed. 409, якщо вчитель у плані.
 */
export async function deleteTeacher(db: Db, ctx: Ctx, teacherId: string): Promise<void> {
  await withSchool(db, ctx.schoolId, async (trx) => {
    const current = await trx.selectFrom('teachers').select(['teacher_no', 'deleted_at']).where('teacher_id', '=', teacherId).executeTakeFirst();
    if (!current) return fail(404, 'not_found', 'Вчителя не знайдено');
    if (current.deleted_at) return;
    const used = await trx.selectFrom('curriculum').select('class_id').where('teacher_id', '=', teacherId).executeTakeFirst();
    if (used) fail(409, 'in_curriculum', 'Вчителя призначено в плані', 'Спершу призначте в плані іншого вчителя');
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    await trx
      .updateTable('teachers')
      .set({ label: null, unavailable_days: [], deleted_at: new Date() })
      .where('teacher_id', '=', teacherId)
      .execute();
    await recordChange(
      trx,
      ctx,
      version,
      [{ entity: 'teacher', op: 'deleted', id: teacherId, teacher_no: current.teacher_no }],
      [{ action: 'teacher_deleted', target: teacherId }],
    );
  });
}

/**
 * Етап 2 · експорт даних вчителя (ст. 8), частина school-service: дані вчителя, рядки плану,
 * записи журналу над ним. web додає частину з timetable-service і віддає один файл. Запис у журнал.
 */
export async function exportTeacher(db: Db, ctx: Ctx, teacherId: string) {
  return withSchool(db, ctx.schoolId, async (trx) => {
    const row = await trx.selectFrom('teachers').selectAll().where('teacher_id', '=', teacherId).executeTakeFirst();
    if (!row) return fail(404, 'not_found', 'Вчителя не знайдено');
    const curriculum = await trx
      .selectFrom('curriculum')
      .innerJoin('classes', (j) => j.onRef('classes.school_id', '=', 'curriculum.school_id').onRef('classes.class_id', '=', 'curriculum.class_id'))
      .innerJoin('subjects', (j) =>
        j.onRef('subjects.school_id', '=', 'curriculum.school_id').onRef('subjects.subject_id', '=', 'curriculum.subject_id'),
      )
      .select(['curriculum.class_id', 'classes.name as class_name', 'curriculum.subject_id', 'subjects.name as subject_name', 'curriculum.hours_per_week'])
      .where('curriculum.teacher_id', '=', teacherId)
      .orderBy('classes.name')
      .execute();
    const audit = await trx
      .selectFrom('audit_log')
      .select(['entry_id', 'at', 'actor', 'action', 'target', 'details'])
      .where('target', '=', teacherId)
      .orderBy('at')
      .execute();
    await writeAudit(trx, ctx.schoolId, ctx.actor, [{ action: 'teacher_exported', target: teacherId }]);
    return {
      source: 'school-service',
      exported_at: new Date().toISOString(),
      teacher: toTeacher(row),
      curriculum,
      audit: audit.map((a) => ({ ...a, at: a.at.toISOString() })),
    };
  });
}
