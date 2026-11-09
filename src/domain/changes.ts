// Кожна зміна даних закладу в одній транзакції (розділ 09):
//   1) snapshot_version + 1 (рядок профілю блокується — зміни одного закладу йдуть по черзі);
//   2) записи журналу дій;
//   3) подія school.data.changed в outbox.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Trx } from '../db/index.js';
import { writeOutbox } from '../db/events.js';

export interface Ctx {
  schoolId: string;
  /** Логін укладача або сервіс-джерело; не прізвище вчителя. */
  actor: string;
  correlationId: string;
}

export type Entity = 'profile' | 'bells' | 'class' | 'subject' | 'teacher' | 'curriculum';
export type Op = 'created' | 'updated' | 'archived' | 'deleted' | 'replaced';

/** Елемент school.data.changed: що змінилось. Лише ідентифікатори, без назв і підписів. */
export interface Change {
  entity: Entity;
  op: Op;
  id?: string;
  /** Для видаленого вчителя: timetable ставить «Вчитель #N» у копіях підписів у версіях. */
  teacher_no?: number;
}

export interface AuditRecord {
  action: string;
  /** Над ким: ідентифікатор (class_id, teacher_id…), не прізвище. */
  target?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Блокує рядок профілю закладу (створює порожній, якщо school.registered ще не прийшов) і
 * повертає наступний snapshot_version. Викликати першим кроком транзакції зміни.
 */
export async function bumpSnapshotVersion(trx: Trx, schoolId: string): Promise<number> {
  await sql`insert into school_profile (school_id) values (${schoolId}) on conflict (school_id) do nothing`.execute(trx);
  const row = await trx
    .updateTable('school_profile')
    .set((eb) => ({ snapshot_version: eb('snapshot_version', '+', 1), updated_at: new Date() }))
    .where('school_id', '=', schoolId)
    .returning('snapshot_version')
    .executeTakeFirstOrThrow();
  return row.snapshot_version;
}

export async function writeAudit(trx: Trx, schoolId: string, actor: string, records: AuditRecord[], at?: Date): Promise<void> {
  if (records.length === 0) return;
  await trx
    .insertInto('audit_log')
    .values(
      records.map((r) => ({
        school_id: schoolId,
        entry_id: randomUUID(),
        actor,
        action: r.action,
        target: r.target ?? null,
        details: JSON.stringify(r.details ?? {}),
        ...(at ? { at } : {}),
      })),
    )
    .execute();
}

/** Завершує зміну: журнал і school.data.changed з уже збільшеним snapshot_version. */
export async function recordChange(
  trx: Trx,
  ctx: Ctx,
  snapshotVersion: number,
  changes: Change[],
  audit: AuditRecord[],
): Promise<void> {
  await writeAudit(trx, ctx.schoolId, ctx.actor, audit);
  await writeOutbox(trx, {
    topic: 'school.data.changed',
    schoolId: ctx.schoolId,
    correlationId: ctx.correlationId,
    data: { snapshot_version: snapshotVersion, changes },
  });
}

/** 23505 — порушення унікальності (зайнята назва, підпис тощо). */
export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
};
