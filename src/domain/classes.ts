// Класи й предмети (розділ 09). Обидва не видаляються, а архівуються (archived_at): на них
// посилаються версії розкладу в timetable-service.
import { randomUUID } from 'node:crypto';
import { withSchool, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { bumpSnapshotVersion, isUniqueViolation, recordChange, type Change, type Ctx } from './changes.js';

export interface SchoolClass {
  class_id: string;
  name: string;
  students: number;
  in_person_priority: boolean;
  archived_at: string | null;
}
export type ClassInput = Pick<SchoolClass, 'name' | 'students' | 'in_person_priority'>;

const toClass = (r: {
  class_id: string;
  name: string;
  students: number;
  in_person_priority: boolean;
  archived_at: Date | null;
}): SchoolClass => ({
  class_id: r.class_id,
  name: r.name,
  students: r.students,
  in_person_priority: r.in_person_priority,
  archived_at: r.archived_at?.toISOString() ?? null,
});

export async function readClasses(trx: Trx): Promise<SchoolClass[]> {
  const rows = await trx.selectFrom('classes').selectAll().orderBy('archived_at', (ob) => ob.desc().nullsFirst()).orderBy('name').execute();
  return rows.map(toClass);
}

/** Активні спершу, архівовані — в кінці; web сам вирішує, чи показувати архів. */
export const listClasses = (db: Db, schoolId: string) => withSchool(db, schoolId, readClasses);

const nameTaken = (name: string) => fail(409, 'name_taken', 'Назва класу зайнята', `Активний клас «${name}» уже є`);

export async function createClass(db: Db, ctx: Ctx, input: ClassInput): Promise<SchoolClass> {
  const name = input.name.trim();
  if (!name) fail(400, 'validation_failed', 'Некоректна назва', 'Назва класу не може бути порожньою');
  try {
    return await withSchool(db, ctx.schoolId, async (trx) => {
      const version = await bumpSnapshotVersion(trx, ctx.schoolId);
      const row = await trx
        .insertInto('classes')
        .values({ school_id: ctx.schoolId, class_id: randomUUID(), name, students: input.students, in_person_priority: input.in_person_priority })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordChange(trx, ctx, version, [{ entity: 'class', op: 'created', id: row.class_id }], [
        { action: 'class_created', target: row.class_id },
      ]);
      return toClass(row);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'classes_active_name')) nameTaken(name);
    throw err;
  }
}

export async function updateClass(db: Db, ctx: Ctx, classId: string, input: ClassInput): Promise<SchoolClass> {
  const name = input.name.trim();
  if (!name) fail(400, 'validation_failed', 'Некоректна назва', 'Назва класу не може бути порожньою');
  try {
    return await withSchool(db, ctx.schoolId, async (trx) => {
      const version = await bumpSnapshotVersion(trx, ctx.schoolId);
      const current = await trx.selectFrom('classes').selectAll().where('class_id', '=', classId).executeTakeFirst();
      if (!current) return fail(404, 'not_found', 'Клас не знайдено');
      if (current.archived_at) fail(409, 'archived', 'Клас архівовано', 'Архівований клас не змінюється');
      const fields = (['name', 'students', 'in_person_priority'] as const).filter((f) =>
        f === 'name' ? current.name !== name : current[f] !== input[f],
      );
      if (fields.length === 0) return toClass(current);
      const row = await trx
        .updateTable('classes')
        .set({ name, students: input.students, in_person_priority: input.in_person_priority })
        .where('class_id', '=', classId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordChange(trx, ctx, version, [{ entity: 'class', op: 'updated', id: classId }], [
        { action: 'class_updated', target: classId, details: { fields } },
      ]);
      return toClass(row);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'classes_active_name')) nameTaken(name);
    throw err;
  }
}

/**
 * Архівування: рядки навчального плану класу видаляються (план архівованого класу не будується),
 * timetable отримує school.data.changed і відкликає QR класу. Повторне архівування нічого не робить.
 */
export async function archiveClass(db: Db, ctx: Ctx, classId: string): Promise<void> {
  await withSchool(db, ctx.schoolId, async (trx) => {
    const current = await trx.selectFrom('classes').select(['archived_at']).where('class_id', '=', classId).executeTakeFirst();
    if (!current) return fail(404, 'not_found', 'Клас не знайдено');
    if (current.archived_at) return;
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    const removed = await trx.deleteFrom('curriculum').where('class_id', '=', classId).executeTakeFirst();
    await trx.updateTable('classes').set({ archived_at: new Date() }).where('class_id', '=', classId).execute();
    const changes: Change[] = [{ entity: 'class', op: 'archived', id: classId }];
    if (Number(removed.numDeletedRows) > 0) changes.push({ entity: 'curriculum', op: 'updated' });
    await recordChange(trx, ctx, version, changes, [
      { action: 'class_archived', target: classId, details: { curriculum_rows_removed: Number(removed.numDeletedRows) } },
    ]);
  });
}

// ───────────── предмети ─────────────

export type EducationArea =
  | 'math'
  | 'science'
  | 'language_literature'
  | 'civic_history'
  | 'informatics'
  | 'arts'
  | 'technology'
  | 'social_health'
  | 'physical';

export interface Subject {
  subject_id: string;
  name: string;
  short_name: string;
  education_area: EducationArea;
  not_in_shelter: boolean;
  archived_at: string | null;
}
export type SubjectInput = Pick<Subject, 'name' | 'short_name' | 'education_area' | 'not_in_shelter'>;

const toSubject = (r: {
  subject_id: string;
  name: string;
  short_name: string;
  education_area: string;
  not_in_shelter: boolean;
  archived_at: Date | null;
}): Subject => ({
  subject_id: r.subject_id,
  name: r.name,
  short_name: r.short_name,
  education_area: r.education_area as EducationArea,
  not_in_shelter: r.not_in_shelter,
  archived_at: r.archived_at?.toISOString() ?? null,
});

export async function readSubjects(trx: Trx): Promise<Subject[]> {
  const rows = await trx.selectFrom('subjects').selectAll().orderBy('archived_at', (ob) => ob.desc().nullsFirst()).orderBy('name').execute();
  return rows.map(toSubject);
}

export const listSubjects = (db: Db, schoolId: string) => withSchool(db, schoolId, readSubjects);

function cleanSubject(input: SubjectInput): SubjectInput {
  const name = input.name.trim();
  const short_name = input.short_name.trim();
  if (!name || !short_name) fail(400, 'validation_failed', 'Некоректний предмет', 'Назва й скорочення не можуть бути порожніми');
  return { ...input, name, short_name };
}

export async function createSubject(db: Db, ctx: Ctx, input: SubjectInput): Promise<Subject> {
  const s = cleanSubject(input);
  return withSchool(db, ctx.schoolId, async (trx) => {
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    const row = await trx
      .insertInto('subjects')
      .values({ school_id: ctx.schoolId, subject_id: randomUUID(), ...s })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordChange(trx, ctx, version, [{ entity: 'subject', op: 'created', id: row.subject_id }], [
      { action: 'subject_created', target: row.subject_id },
    ]);
    return toSubject(row);
  });
}

export async function updateSubject(db: Db, ctx: Ctx, subjectId: string, input: SubjectInput): Promise<Subject> {
  const s = cleanSubject(input);
  return withSchool(db, ctx.schoolId, async (trx) => {
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    const current = await trx.selectFrom('subjects').selectAll().where('subject_id', '=', subjectId).executeTakeFirst();
    if (!current) return fail(404, 'not_found', 'Предмет не знайдено');
    if (current.archived_at) fail(409, 'archived', 'Предмет архівовано', 'Архівований предмет не змінюється');
    const fields = (['name', 'short_name', 'education_area', 'not_in_shelter'] as const).filter((f) => current[f] !== s[f]);
    if (fields.length === 0) return toSubject(current);
    const row = await trx.updateTable('subjects').set(s).where('subject_id', '=', subjectId).returningAll().executeTakeFirstOrThrow();
    await recordChange(trx, ctx, version, [{ entity: 'subject', op: 'updated', id: subjectId }], [
      { action: 'subject_updated', target: subjectId, details: { fields } },
    ]);
    return toSubject(row);
  });
}

/** 409 in_curriculum, якщо предмет є в плані (розділ 09). */
export async function archiveSubject(db: Db, ctx: Ctx, subjectId: string): Promise<void> {
  await withSchool(db, ctx.schoolId, async (trx) => {
    const current = await trx.selectFrom('subjects').select(['archived_at']).where('subject_id', '=', subjectId).executeTakeFirst();
    if (!current) return fail(404, 'not_found', 'Предмет не знайдено');
    if (current.archived_at) return;
    const used = await trx.selectFrom('curriculum').select('class_id').where('subject_id', '=', subjectId).executeTakeFirst();
    if (used) fail(409, 'in_curriculum', 'Предмет є в навчальному плані', 'Спершу приберіть предмет з плану');
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    await trx.updateTable('subjects').set({ archived_at: new Date() }).where('subject_id', '=', subjectId).execute();
    await recordChange(trx, ctx, version, [{ entity: 'subject', op: 'archived', id: subjectId }], [
      { action: 'subject_archived', target: subjectId },
    ]);
  });
}
