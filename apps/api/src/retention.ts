import { query } from './db.js';

export const DEFAULT_RRWEB_RETENTION_DAYS = 14;

export function getRrwebRetentionDays(): number {
  const n = Number(process.env.RRWEB_RETENTION_DAYS ?? DEFAULT_RRWEB_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RRWEB_RETENTION_DAYS;
}

/** Purge rrweb payloads for sessions that already have segmented workflows. */
export async function purgeStaleRrwebEvents(): Promise<number> {
  const days = getRrwebRetentionDays();
  const rows = await query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM rrweb_events e
       WHERE e.created_at < NOW() - ($1::int * INTERVAL '1 day')
         AND EXISTS (
           SELECT 1 FROM recording_sessions rs
           JOIN workflows w ON w.session_id = rs.id
           WHERE rs.id = e.session_id
         )
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
    [days],
  );
  return Number(rows[0]?.count ?? 0);
}
