// Журнал дій закладу (розділ 09): власні записи school-service пишуться в транзакції зміни,
// дії timetable приходять подією audit.recorded, реєстрація — з school.registered.
import { sql } from 'kysely';
import { withSchool, type Db } from '../db/index.js';

export interface AuditEntry {
  entry_id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  /** Дати 'YYYY-MM-DD' включно, за Europe/Kyiv (розділ 04, «Модель часу»). */
  from: string;
  to: string;
  target?: string;
}

export async function listAudit(db: Db, schoolId: string, q: AuditQuery): Promise<AuditEntry[]> {
  return withSchool(db, schoolId, async (trx) => {
    let query = trx
      .selectFrom('audit_log')
      .select(['entry_id', 'at', 'actor', 'action', 'target', 'details'])
      .where('at', '>=', sql<Date>`(${q.from}::date)::timestamp at time zone 'Europe/Kyiv'`)
      .where('at', '<', sql<Date>`(${q.to}::date + 1)::timestamp at time zone 'Europe/Kyiv'`);
    if (q.target) query = query.where('target', '=', q.target);
    const rows = await query.orderBy('at', 'desc').orderBy('entry_id').execute();
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  });
}
