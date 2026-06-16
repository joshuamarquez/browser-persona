import { query } from './db.js';

export interface CapabilityRunRecord {
  id: string;
  capability_id: string;
  capability_name: string;
  status: string;
  parameters: Record<string, unknown>;
  task_results: unknown[];
  planner_calls: number;
  error_message: string | null;
  started_at: string;
  finished_at: string;
}

export async function recordCapabilityRun(input: {
  capabilityId: string;
  userId: string;
  status: 'success' | 'failed';
  parameters?: Record<string, unknown>;
  taskResults?: unknown[];
  plannerCalls?: number;
  errorMessage?: string;
  startedAt?: Date;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO capability_runs (
       capability_id, user_id, status, parameters, task_results,
       planner_calls, error_message, started_at, finished_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), now())
     RETURNING id`,
    [
      input.capabilityId,
      input.userId,
      input.status,
      JSON.stringify(input.parameters ?? {}),
      JSON.stringify(input.taskResults ?? []),
      input.plannerCalls ?? 0,
      input.errorMessage ?? null,
      input.startedAt ?? null,
    ],
  );
  return rows[0].id;
}

export async function listCapabilityRuns(
  userId: string,
  options?: { capabilityId?: string; limit?: number },
): Promise<CapabilityRunRecord[]> {
  const limit = options?.limit ?? 50;
  const params: unknown[] = [userId, limit];
  let capabilityFilter = '';

  if (options?.capabilityId) {
    capabilityFilter = 'AND cr.capability_id = $3';
    params.push(options.capabilityId);
  }

  return query<CapabilityRunRecord>(
    `SELECT cr.id, cr.capability_id, c.name AS capability_name, cr.status,
            cr.parameters, cr.task_results, cr.planner_calls, cr.error_message,
            cr.started_at, cr.finished_at
     FROM capability_runs cr
     JOIN capabilities c ON c.id = cr.capability_id
     WHERE cr.user_id = $1 ${capabilityFilter}
     ORDER BY cr.finished_at DESC
     LIMIT $2`,
    params,
  );
}
