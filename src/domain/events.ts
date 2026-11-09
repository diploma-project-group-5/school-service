// Обробка вхідних подій (розділ 12): school.registered від tenant і audit.recorded від timetable.
// Кожна подія обробляється в транзакції закладу з конверта; event_id пишеться в inbox, повтор
// пропускається. Помилка — виняток: консюмер повторить спробу, після трьох — DLQ.
import { withSchool, type Db } from '../db/index.js';
import { claimInbox, InvalidEventError, type Envelope } from '../db/events.js';
import { writeAudit } from './changes.js';

export type HandleResult = 'processed' | 'duplicate';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** school.registered: порожній профіль з назвою і запис журналу «заклад зареєстровано». */
export async function handleSchoolRegistered(db: Db, e: Envelope): Promise<HandleResult> {
  const name = str(e.data.name)?.trim().slice(0, 200);
  if (!name) throw new InvalidEventError('school.registered без назви');
  return withSchool(db, e.school_id, async (trx) => {
    if (!(await claimInbox(trx, e.school_id, e.event_id, 'school.registered'))) return 'duplicate';
    const registeredAt = new Date(str(e.data.registered_at) ?? e.time);
    // Профіль міг з'явитися раніше (укладач зберіг дані до приходу події) — лише ставимо назву.
    // snapshot_version не змінюється: назва не впливає на розклад.
    await trx
      .insertInto('school_profile')
      .values({ school_id: e.school_id, name, registered_at: registeredAt })
      .onConflict((oc) => oc.column('school_id').doUpdateSet({ name, registered_at: registeredAt }))
      .execute();
    await writeAudit(trx, e.school_id, 'tenant-service', [{ action: 'school_registered', target: e.school_id }], registeredAt);
    return 'processed';
  });
}

/**
 * audit.recorded: запис журналу про дію в timetable (публікація, розклад тривог, заміни, QR…).
 * Журнал без прізвищ: у details мають бути лише ідентифікатори — так пише timetable.
 */
export async function handleAuditRecorded(db: Db, e: Envelope): Promise<HandleResult> {
  const action = str(e.data.action);
  const actor = str(e.data.actor);
  if (!action || !actor) throw new InvalidEventError('audit.recorded без action чи actor');
  const at = new Date(str(e.data.at) ?? e.time);
  if (Number.isNaN(at.getTime())) throw new InvalidEventError('audit.recorded з некоректним at');
  const details = e.data.details && typeof e.data.details === 'object' ? (e.data.details as Record<string, unknown>) : {};
  return withSchool(db, e.school_id, async (trx) => {
    if (!(await claimInbox(trx, e.school_id, e.event_id, 'audit.recorded'))) return 'duplicate';
    await writeAudit(trx, e.school_id, actor.slice(0, 200), [{ action: action.slice(0, 100), target: str(e.data.target) ?? null, details }], at);
    return 'processed';
  });
}

export const handlers: Record<string, (db: Db, e: Envelope) => Promise<HandleResult>> = {
  'school.registered': handleSchoolRegistered,
  'audit.recorded': handleAuditRecorded,
};
