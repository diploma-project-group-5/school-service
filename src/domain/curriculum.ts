// Навчальний план (розділ 09): клас × предмет → вчитель, годин на тиждень. PUT замінює план цілком.
import { withSchool, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { bumpSnapshotVersion, recordChange, type Ctx } from './changes.js';

export interface CurriculumRow {
  class_id: string;
  subject_id: string;
  teacher_id: string;
  hours_per_week: number;
}

export async function readCurriculum(trx: Trx): Promise<CurriculumRow[]> {
  return trx
    .selectFrom('curriculum')
    .select(['class_id', 'subject_id', 'teacher_id', 'hours_per_week'])
    .orderBy('class_id')
    .orderBy('subject_id')
    .execute();
}

export const getCurriculum = (db: Db, schoolId: string) => withSchool(db, schoolId, readCurriculum);

export async function replaceCurriculum(db: Db, ctx: Ctx, rows: CurriculumRow[]): Promise<CurriculumRow[]> {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.class_id}|${r.subject_id}`;
    if (seen.has(key)) fail(400, 'validation_failed', 'Некоректний план', 'Пара клас × предмет повторюється');
    seen.add(key);
  }
  return withSchool(db, ctx.schoolId, async (trx) => {
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    // Посилання лише на активні класи й предмети та невидалених вчителів цього закладу (RLS).
    const ids = (field: 'class_id' | 'subject_id' | 'teacher_id') => [...new Set(rows.map((r) => r[field]))];
    const classIds = ids('class_id');
    const subjectIds = ids('subject_id');
    const teacherIds = ids('teacher_id');
    const [classes, subjects, teachers] = await Promise.all([
      classIds.length
        ? trx.selectFrom('classes').select('class_id').where('class_id', 'in', classIds).where('archived_at', 'is', null).execute()
        : [],
      subjectIds.length
        ? trx.selectFrom('subjects').select('subject_id').where('subject_id', 'in', subjectIds).where('archived_at', 'is', null).execute()
        : [],
      teacherIds.length
        ? trx.selectFrom('teachers').select('teacher_id').where('teacher_id', 'in', teacherIds).where('deleted_at', 'is', null).execute()
        : [],
    ]);
    const missing = (all: string[], found: string[]) => all.filter((id) => !found.includes(id));
    const badClasses = missing(classIds, classes.map((c) => c.class_id));
    const badSubjects = missing(subjectIds, subjects.map((s) => s.subject_id));
    const badTeachers = missing(teacherIds, teachers.map((t) => t.teacher_id));
    if (badClasses.length || badSubjects.length || badTeachers.length) {
      const parts = [
        badClasses.length ? `класи: ${badClasses.join(', ')}` : '',
        badSubjects.length ? `предмети: ${badSubjects.join(', ')}` : '',
        badTeachers.length ? `вчителі: ${badTeachers.join(', ')}` : '',
      ].filter(Boolean);
      fail(422, 'unknown_reference', 'План посилається на неактивні дані', `Немає або архівовано — ${parts.join('; ')}`);
    }
    await trx.deleteFrom('curriculum').where('school_id', '=', ctx.schoolId).execute();
    if (rows.length > 0) {
      await trx
        .insertInto('curriculum')
        .values(rows.map((r) => ({ school_id: ctx.schoolId, ...r })))
        .execute();
    }
    await recordChange(trx, ctx, version, [{ entity: 'curriculum', op: 'replaced' }], [
      { action: 'curriculum_replaced', target: ctx.schoolId, details: { rows: rows.length } },
    ]);
    return readCurriculum(trx);
  });
}
