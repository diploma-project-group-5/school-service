// Доступ до бази school через Kysely.
//
// ТИМЧАСОВО до появи пакета @lad/db: withSchool, outbox та inbox живуть тут (так само, як у
// tenant-service). Специфікація (розділ 03, рішення про полірепо) вимагає, щоб вони були лише в
// @lad/db; коли пакет з'явиться, цей модуль замінюється імпортом з нього.
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated, type Transaction } from 'kysely';
import pg from 'pg';

// bigint (snapshot_version) повертаємо числом: до 2^53 заклад не дійде, а JSON bigint не вміє.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// time без дати лишаємо рядком 'HH:MM:SS'.
pg.types.setTypeParser(pg.types.builtins.TIME, (v) => v);

export interface SchoolProfileTable {
  school_id: string;
  name: string | null;
  lessons_per_day: number | null;
  saturday: Generated<boolean>;
  shelter_capacity: number | null;
  non_teaching_staff: number | null;
  shelter_seats: number | null;
  snapshot_version: Generated<number>;
  registered_at: Date | null;
  updated_at: Generated<Date>;
}

export interface BellsTable {
  school_id: string;
  lesson_no: number;
  starts_at: string;
  ends_at: string;
}

export interface ClassesTable {
  school_id: string;
  class_id: string;
  name: string;
  students: number;
  in_person_priority: boolean;
  archived_at: Date | null;
  created_at: Generated<Date>;
}

export interface SubjectsTable {
  school_id: string;
  subject_id: string;
  name: string;
  short_name: string;
  education_area: string;
  not_in_shelter: boolean;
  archived_at: Date | null;
  created_at: Generated<Date>;
}

export interface TeachersTable {
  school_id: string;
  teacher_id: string;
  teacher_no: number;
  /** null після видалення даних вчителя (ст. 15): лишається лише «Вчитель #N». */
  label: string | null;
  weekly_hours_limit: number;
  unavailable_days: number[];
  deleted_at: Date | null;
  created_at: Generated<Date>;
}

export interface CurriculumTable {
  school_id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  hours_per_week: number;
}

export interface AuditLogTable {
  school_id: string;
  entry_id: string;
  at: Generated<Date>;
  actor: string;
  action: string;
  target: string | null;
  details: ColumnType<Record<string, unknown>, string, never>;
}

export interface OutboxTable {
  school_id: string;
  event_id: string;
  topic: string;
  payload: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
  published_at: Date | null;
}

export interface InboxTable {
  school_id: string;
  event_id: string;
  topic: string;
  received_at: Generated<Date>;
}

export interface Database {
  school_profile: SchoolProfileTable;
  bells: BellsTable;
  classes: ClassesTable;
  subjects: SubjectsTable;
  teachers: TeachersTable;
  curriculum: CurriculumTable;
  audit_log: AuditLogTable;
  outbox: OutboxTable;
  inbox: InboxTable;
}

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: maxConnections }) }),
  });
}

/**
 * Транзакція в контексті одного закладу: політики RLS читають app.school_id.
 * set_config(..., true) діє лише до кінця транзакції, тож заклад не «протікає» в інші запити пулу.
 */
export async function withSchool<T>(db: Db, schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.school_id', ${schoolId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Те саме, але REPEATABLE READ: знімок даних закладу читається узгоджено, одним моментом. */
export async function withSchoolSnapshot<T>(db: Db, schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      await sql`select set_config('app.school_id', ${schoolId}, true)`.execute(trx);
      return fn(trx);
    });
}
