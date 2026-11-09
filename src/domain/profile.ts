// Профіль закладу й основний розклад дзвінків (розділ 09: GET/PUT /school, GET/PUT /bells).
import { withSchool, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { bumpSnapshotVersion, recordChange, type Ctx } from './changes.js';

export interface SchoolProfile {
  name: string;
  lessons_per_day: number | null;
  saturday: boolean;
  shelter_capacity: number | null;
  non_teaching_staff: number | null;
  shelter_seats: number | null;
  snapshot_version: number;
}

export const EDITABLE_PROFILE_FIELDS = [
  'lessons_per_day',
  'saturday',
  'shelter_capacity',
  'non_teaching_staff',
  'shelter_seats',
] as const;
type EditableField = (typeof EDITABLE_PROFILE_FIELDS)[number];
export type ProfilePatch = Partial<Pick<SchoolProfile, EditableField>>;

export const EMPTY_PROFILE: SchoolProfile = {
  name: '',
  lessons_per_day: null,
  saturday: false,
  shelter_capacity: null,
  non_teaching_staff: null,
  shelter_seats: null,
  snapshot_version: 0,
};

async function readProfile(trx: Trx, schoolId: string): Promise<SchoolProfile> {
  const row = await trx.selectFrom('school_profile').selectAll().where('school_id', '=', schoolId).executeTakeFirst();
  if (!row) return { ...EMPTY_PROFILE };
  return {
    name: row.name ?? '',
    lessons_per_day: row.lessons_per_day,
    saturday: row.saturday,
    shelter_capacity: row.shelter_capacity,
    non_teaching_staff: row.non_teaching_staff,
    shelter_seats: row.shelter_seats,
    snapshot_version: row.snapshot_version,
  };
}

/** До приходу school.registered — 200 з порожнім профілем, а не 404 (розділ 09). */
export const getProfile = (db: Db, schoolId: string) => withSchool(db, schoolId, (trx) => readProfile(trx, schoolId));

export async function updateProfile(db: Db, ctx: Ctx, patch: ProfilePatch): Promise<SchoolProfile> {
  return withSchool(db, ctx.schoolId, async (trx) => {
    const current = await readProfile(trx, ctx.schoolId);
    const changed = EDITABLE_PROFILE_FIELDS.filter((f) => patch[f] !== undefined && patch[f] !== current[f]);
    if (changed.length === 0) return current;
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    const values: ProfilePatch = {};
    for (const f of changed) (values as Record<string, unknown>)[f] = patch[f];
    await trx.updateTable('school_profile').set(values).where('school_id', '=', ctx.schoolId).execute();
    await recordChange(trx, ctx, version, [{ entity: 'profile', op: 'updated' }], [
      { action: 'profile_updated', target: ctx.schoolId, details: { fields: changed } },
    ]);
    return readProfile(trx, ctx.schoolId);
  });
}

// ───────────── дзвінки ─────────────

export interface Bell {
  lesson_no: number;
  /** 'HH:MM' */
  start: string;
  end: string;
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const getBellsIn = (trx: Trx) => readBells(trx);

async function readBells(trx: Trx): Promise<Bell[]> {
  const rows = await trx.selectFrom('bells').selectAll().orderBy('lesson_no').execute();
  return rows.map((r) => ({ lesson_no: r.lesson_no, start: r.starts_at.slice(0, 5), end: r.ends_at.slice(0, 5) }));
}

export const getBells = (db: Db, schoolId: string) => withSchool(db, schoolId, readBells);

/** Перевіряє розклад дзвінків: унікальні номери, початок раніше кінця, уроки не перетинаються. */
export function checkBells(bells: Bell[]): void {
  const sorted = [...bells].sort((a, b) => a.lesson_no - b.lesson_no);
  const seen = new Set<number>();
  for (const b of sorted) {
    if (seen.has(b.lesson_no)) fail(400, 'validation_failed', 'Некоректні дзвінки', `Урок №${b.lesson_no} вказано двічі`);
    seen.add(b.lesson_no);
    if (!TIME_RE.test(b.start) || !TIME_RE.test(b.end)) {
      fail(400, 'validation_failed', 'Некоректні дзвінки', `Урок №${b.lesson_no}: час у форматі HH:MM`);
    }
    if (b.start >= b.end) fail(400, 'validation_failed', 'Некоректні дзвінки', `Урок №${b.lesson_no}: початок має бути раніше кінця`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) {
      fail(400, 'validation_failed', 'Некоректні дзвінки', `Урок №${cur.lesson_no} починається раніше, ніж закінчується №${prev.lesson_no}`);
    }
  }
}

export async function replaceBells(db: Db, ctx: Ctx, bells: Bell[]): Promise<Bell[]> {
  checkBells(bells);
  return withSchool(db, ctx.schoolId, async (trx) => {
    const version = await bumpSnapshotVersion(trx, ctx.schoolId);
    await trx.deleteFrom('bells').where('school_id', '=', ctx.schoolId).execute();
    if (bells.length > 0) {
      await trx
        .insertInto('bells')
        .values(bells.map((b) => ({ school_id: ctx.schoolId, lesson_no: b.lesson_no, starts_at: b.start, ends_at: b.end })))
        .execute();
    }
    await recordChange(trx, ctx, version, [{ entity: 'bells', op: 'replaced' }], [
      { action: 'bells_replaced', target: ctx.schoolId, details: { lessons: bells.length } },
    ]);
    return readBells(trx);
  });
}
