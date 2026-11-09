// Міграції бази school. Виконуються роллю school_owner окремою командою (npm run migrate),
// а не при старті сервісу: робоча роль school_app не володіє таблицями.
// Ролі school_app, school_relay, school_maint створює db-init у репозиторії platform.
//
// Ізоляція закладів (розділ 03): school_id першим у кожному первинному ключі, FORCE ROW LEVEL
// SECURITY на кожній таблиці, заклад — лише з set_config('app.school_id', …, true).
// relay і maint працюють поза одним закладом: окремі політики TO <роль> USING (true) лише на
// своїх таблицях, без BYPASSRLS.
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const CURRENT_SCHOOL = sql.raw(`nullif(current_setting('app.school_id', true), '')::uuid`);

/** Таблиця закладу: RLS + FORCE + політика для school_app. */
async function isolate(db: Kysely<unknown>, table: string): Promise<void> {
  const t = sql.raw(table);
  await sql`alter table ${t} enable row level security`.execute(db);
  await sql`alter table ${t} force row level security`.execute(db);
  await sql`
    create policy ${sql.raw(`${table}_app`)} on ${t} to school_app
      using (school_id = ${CURRENT_SCHOOL})
      with check (school_id = ${CURRENT_SCHOOL})`.execute(db);
}

export const EDUCATION_AREAS = [
  'math',
  'science',
  'language_literature',
  'civic_history',
  'informatics',
  'arts',
  'technology',
  'social_health',
  'physical',
] as const;

const migrations: Record<string, Migration> = {
  '0001_school_data': {
    async up(db: Kysely<unknown>) {
      // Профіль закладу. Назва приходить з school.registered і через API не змінюється.
      // snapshot_version збільшується в транзакції кожної зміни даних закладу; рядок профілю
      // заодно серіалізує зміни одного закладу (UPDATE … бере блокування рядка).
      await sql`
        create table school_profile (
          school_id          uuid primary key,
          name               text check (name is null or length(name) between 1 and 200),
          lessons_per_day    smallint check (lessons_per_day between 1 and 10),
          saturday           boolean not null default false,
          shelter_capacity   integer check (shelter_capacity >= 0),
          non_teaching_staff integer check (non_teaching_staff >= 0),
          shelter_seats      integer check (shelter_seats >= 0),
          snapshot_version   bigint not null default 0,
          registered_at      timestamptz,
          updated_at         timestamptz not null default now()
        )`.execute(db);

      await sql`
        create table bells (
          school_id uuid not null,
          lesson_no smallint not null check (lesson_no between 1 and 10),
          starts_at time not null,
          ends_at   time not null,
          primary key (school_id, lesson_no),
          check (starts_at < ends_at)
        )`.execute(db);

      // Клас не видаляється, а архівується: на нього посилаються версії розкладу в timetable.
      await sql`
        create table classes (
          school_id          uuid not null,
          class_id           uuid not null,
          name               text not null check (length(name) between 1 and 50),
          students           smallint not null check (students between 0 and 60),
          in_person_priority boolean not null default false,
          archived_at        timestamptz,
          created_at         timestamptz not null default now(),
          primary key (school_id, class_id)
        )`.execute(db);
      await sql`create unique index classes_active_name on classes (school_id, lower(name)) where archived_at is null`.execute(db);

      await sql`
        create table subjects (
          school_id      uuid not null,
          subject_id     uuid not null,
          name           text not null check (length(name) between 1 and 100),
          short_name     text not null check (length(short_name) between 1 and 20),
          education_area text not null check (education_area in (${sql.join(EDUCATION_AREAS.map((a) => sql.lit(a)))})),
          not_in_shelter boolean not null default false,
          archived_at    timestamptz,
          created_at     timestamptz not null default now(),
          primary key (school_id, subject_id)
        )`.execute(db);

      // Мінімум ПД вчителя (розділ 04): лише підпис, унікальний у закладі. Після видалення
      // (ст. 15) підпис стирається, лишається teacher_no — «Вчитель #N».
      await sql`
        create table teachers (
          school_id          uuid not null,
          teacher_id         uuid not null,
          teacher_no         integer not null check (teacher_no > 0),
          label              text check (length(label) between 1 and 100),
          weekly_hours_limit smallint not null check (weekly_hours_limit between 0 and 60),
          unavailable_days   smallint[] not null default '{}'
                             check (unavailable_days <@ array[1,2,3,4,5,6]::smallint[]),
          deleted_at         timestamptz,
          created_at         timestamptz not null default now(),
          primary key (school_id, teacher_id),
          unique (school_id, teacher_no),
          check ((deleted_at is null) = (label is not null))
        )`.execute(db);
      await sql`create unique index teachers_active_label on teachers (school_id, label) where deleted_at is null`.execute(db);

      await sql`
        create table curriculum (
          school_id      uuid not null,
          class_id       uuid not null,
          subject_id     uuid not null,
          teacher_id     uuid not null,
          hours_per_week smallint not null check (hours_per_week between 1 and 60),
          primary key (school_id, class_id, subject_id),
          foreign key (school_id, class_id) references classes (school_id, class_id),
          foreign key (school_id, subject_id) references subjects (school_id, subject_id),
          foreign key (school_id, teacher_id) references teachers (school_id, teacher_id)
        )`.execute(db);
      await sql`create index curriculum_teacher on curriculum (school_id, teacher_id)`.execute(db);
      await sql`create index curriculum_subject on curriculum (school_id, subject_id)`.execute(db);

      // Журнал дій: незмінний (лише INSERT для school_app), 1 рік, без прізвищ — лише id.
      await sql`
        create table audit_log (
          school_id uuid not null,
          entry_id  uuid not null,
          at        timestamptz not null default now(),
          actor     text not null,
          action    text not null,
          target    text,
          details   jsonb not null default '{}',
          primary key (school_id, entry_id)
        )`.execute(db);
      await sql`create index audit_log_at on audit_log (school_id, at desc)`.execute(db);
      await sql`create index audit_log_cleanup on audit_log (at)`.execute(db);

      await sql`
        create table outbox (
          school_id    uuid not null,
          event_id     uuid not null,
          topic        text not null,
          payload      jsonb not null,
          created_at   timestamptz not null default now(),
          published_at timestamptz,
          primary key (school_id, event_id)
        )`.execute(db);
      await sql`create index outbox_unpublished on outbox (created_at) where published_at is null`.execute(db);

      // Inbox: event_id вже оброблених подій; повтор пропускається.
      await sql`
        create table inbox (
          school_id   uuid not null,
          event_id    uuid not null,
          topic       text not null,
          received_at timestamptz not null default now(),
          primary key (school_id, event_id)
        )`.execute(db);
      await sql`create index inbox_received on inbox (received_at)`.execute(db);

      for (const table of ['school_profile', 'bells', 'classes', 'subjects', 'teachers', 'curriculum', 'audit_log', 'outbox', 'inbox']) {
        await isolate(db, table);
      }
      await sql`create policy outbox_relay on outbox to school_relay using (true) with check (true)`.execute(db);
      await sql`create policy outbox_maint on outbox to school_maint using (true)`.execute(db);
      await sql`create policy inbox_maint on inbox to school_maint using (true)`.execute(db);
      await sql`create policy audit_log_maint on audit_log to school_maint using (true)`.execute(db);

      await sql`grant select, insert, update on school_profile to school_app`.execute(db);
      await sql`grant select, insert, update, delete on bells, classes, subjects, teachers, curriculum to school_app`.execute(db);
      await sql`grant select, insert on audit_log to school_app`.execute(db);
      await sql`grant insert on outbox to school_app`.execute(db);
      await sql`grant select, insert on inbox to school_app`.execute(db);
      await sql`grant select, update on outbox to school_relay`.execute(db);
      await sql`grant select, delete on outbox, inbox, audit_log to school_maint`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      for (const table of ['inbox', 'outbox', 'audit_log', 'curriculum', 'teachers', 'subjects', 'classes', 'bells', 'school_profile']) {
        await sql`drop table ${sql.raw(table)}`.execute(db);
      }
    },
  },
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
