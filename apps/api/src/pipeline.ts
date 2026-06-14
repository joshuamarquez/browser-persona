import { segmentWorkflows } from '@browser-persona/event-normalizer';
import { detectPatterns, detectPatternsWithMerge, type MinerWorkflow } from '@browser-persona/pattern-miner';
import { compactWorkflowSteps, judgeWorkflowMerge } from './llm-merge.js';
import { query } from './db.js';

export const DEFAULT_PIPELINE_IDLE_MS = 90_000;
export const DEFAULT_PIPELINE_INTERVAL_MS = 60_000;

export function getPipelineIdleMs(): number {
  const n = Number(process.env.PIPELINE_IDLE_MS ?? DEFAULT_PIPELINE_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PIPELINE_IDLE_MS;
}

export function getPatternMinOccurrences(): number {
  const n = Number(process.env.PATTERN_MIN_OCCURRENCES ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

export function getPipelineIntervalMs(): number {
  const n = Number(process.env.PIPELINE_INTERVAL_MS ?? DEFAULT_PIPELINE_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PIPELINE_INTERVAL_MS;
}

export function isLlmPatternMergeEnabled(): boolean {
  if (process.env.LLM_PATTERN_MERGE === 'false') return false;
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getLlmPatternMergeMaxPairs(): number {
  const n = Number(process.env.LLM_PATTERN_MERGE_MAX_PAIRS ?? 30);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

export interface SegmentSessionResult {
  sessionId: string;
  workflowsCreated: number;
  workflowIds: string[];
}

export interface MinePatternsResult {
  patternsFound: number;
  patternIds: string[];
  llmMergePairsJudged?: number;
  llmMergePairsMerged?: number;
}

export interface PipelineRunResult {
  sessionsClosed: number;
  sessionsSegmented: number;
  workflowsCreated: number;
  patternsFound: number;
  sessionIds: string[];
  workflowIds: string[];
  patternIds: string[];
  llmMergePairsJudged?: number;
  llmMergePairsMerged?: number;
}

/** Mark sessions idle with no recent events as ended (uses last event timestamp). */
export async function closeIdleSessions(
  userId: string,
  idleMs = getPipelineIdleMs(),
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE recording_sessions rs
     SET ended_at = sub.last_event_at
     FROM (
       SELECT e.session_id,
              to_timestamp(MAX(e.timestamp_ms) / 1000.0) AS last_event_at
       FROM rrweb_events e
       GROUP BY e.session_id
     ) sub
     WHERE rs.id = sub.session_id
       AND rs.user_id = $1
       AND rs.ended_at IS NULL
       AND sub.last_event_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')
     RETURNING rs.id`,
    [userId, idleMs],
  );
  return rows.map((r) => r.id);
}

/** Explicit session end (e.g. tab closed in extension). */
export async function endRecordingSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE recording_sessions rs
     SET ended_at = COALESCE(
       (SELECT to_timestamp(MAX(e.timestamp_ms) / 1000.0)
        FROM rrweb_events e WHERE e.session_id = rs.id),
       NOW()
     )
     WHERE rs.id = $1 AND rs.user_id = $2 AND rs.ended_at IS NULL
     RETURNING rs.id`,
    [sessionId, userId],
  );
  return rows.length > 0;
}

/** Segment one session into workflows. Idempotent via segmented_at. */
export async function segmentSession(
  sessionId: string,
  userId: string,
  options?: { force?: boolean },
): Promise<SegmentSessionResult> {
  const existing = await query<{ segmented_at: string | null }>(
    `SELECT segmented_at FROM recording_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );

  if (existing.length === 0) {
    throw new Error('Session not found');
  }

  if (existing[0].segmented_at && !options?.force) {
    const workflows = await query<{ id: string }>(
      `SELECT id FROM workflows WHERE session_id = $1 ORDER BY created_at`,
      [sessionId],
    );
    return {
      sessionId,
      workflowsCreated: 0,
      workflowIds: workflows.map((w) => w.id),
    };
  }

  if (options?.force) {
    await query(
      `UPDATE workflow_patterns SET example_workflow_id = NULL
       WHERE example_workflow_id IN (SELECT id FROM workflows WHERE session_id = $1)`,
      [sessionId],
    );
    await query(`DELETE FROM workflows WHERE session_id = $1`, [sessionId]);
    await query(
      `UPDATE recording_sessions SET segmented_at = NULL WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  }

  const rows = await query<{ payload: object; timestamp_ms: number }>(
    `SELECT payload, timestamp_ms FROM rrweb_events
     WHERE session_id = $1 ORDER BY seq ASC`,
    [sessionId],
  );

  const events = rows.map((r) => ({
    ...(r.payload as { type: number; timestamp: number; data?: unknown }),
    timestamp: (r.payload as { timestamp: number }).timestamp ?? r.timestamp_ms,
  }));

  const segments = segmentWorkflows(events);
  const created: string[] = [];

  for (const seg of segments) {
    const wf = await query<{ id: string }>(
      `INSERT INTO workflows (user_id, session_id, started_at, ended_at, primary_domain, step_count, fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'raw')
       RETURNING id`,
      [
        userId,
        sessionId,
        seg.startedAt,
        seg.endedAt,
        seg.primaryDomain,
        seg.steps.length,
        seg.fingerprint,
      ],
    );
    const workflowId = wf[0].id;
    created.push(workflowId);

    for (let i = 0; i < seg.steps.length; i++) {
      const step = seg.steps[i];
      await query(
        `INSERT INTO workflow_steps (workflow_id, step_index, action, target, value, url, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          workflowId,
          i,
          step.action,
          JSON.stringify(step.target ?? {}),
          step.value != null ? JSON.stringify(step.value) : null,
          step.url ?? null,
          step.occurredAt,
        ],
      );
    }
  }

  await query(
    `UPDATE recording_sessions SET segmented_at = NOW() WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );

  return { sessionId, workflowsCreated: created.length, workflowIds: created };
}

async function loadWorkflowStepsForOne(
  workflowId: string,
): Promise<Array<{ action: string; target: object; value: unknown; url: string | null }>> {
  return query<{ action: string; target: object; value: unknown; url: string | null }>(
    `SELECT action, target, value, url FROM workflow_steps
     WHERE workflow_id = $1 ORDER BY step_index`,
    [workflowId],
  );
}

async function detectPatternsForUser(
  minerWorkflows: MinerWorkflow[],
): Promise<{
  patterns: ReturnType<typeof detectPatterns>;
  llmMergePairsJudged?: number;
  llmMergePairsMerged?: number;
}> {
  const detectOptions = { minOccurrences: getPatternMinOccurrences() };

  if (!isLlmPatternMergeEnabled()) {
    return { patterns: detectPatterns(minerWorkflows, detectOptions) };
  }

  const stepCache = new Map<
    string,
    Array<{ action: string; target: object; value: unknown; url: string | null }>
  >();

  async function stepsFor(workflowId: string) {
    let steps = stepCache.get(workflowId);
    if (!steps) {
      steps = await loadWorkflowStepsForOne(workflowId);
      stepCache.set(workflowId, steps);
    }
    return steps;
  }

  const result = await detectPatternsWithMerge(
    minerWorkflows,
    {
      ...detectOptions,
      maxPairs: getLlmPatternMergeMaxPairs(),
    },
    async (a, b) => {
      const [stepsA, stepsB] = await Promise.all([stepsFor(a.id), stepsFor(b.id)]);
      return judgeWorkflowMerge(
        { id: a.id, domain: a.primaryDomain, steps: compactWorkflowSteps(stepsA) },
        { id: b.id, domain: b.primaryDomain, steps: compactWorkflowSteps(stepsB) },
      );
    },
  );

  return {
    patterns: result.patterns,
    llmMergePairsJudged: result.pairsJudged,
    llmMergePairsMerged: result.pairsMerged,
  };
}

/** Mine patterns from all workflows for a user. */
export async function minePatterns(userId: string): Promise<MinePatternsResult> {
  const workflows = await query<{
    id: string;
    fingerprint: string;
    primary_domain: string;
    step_count: number;
    ended_at: string;
  }>(
    `SELECT id, fingerprint, primary_domain, step_count, ended_at
     FROM workflows WHERE user_id = $1 AND fingerprint IS NOT NULL`,
    [userId],
  );

  const minerWorkflows: MinerWorkflow[] = workflows.map((w) => ({
    id: w.id,
    fingerprint: w.fingerprint,
    primaryDomain: w.primary_domain,
    stepCount: w.step_count,
    lastSeenAt: w.ended_at,
  }));

  const { patterns: detected, llmMergePairsJudged, llmMergePairsMerged } =
    await detectPatternsForUser(minerWorkflows);

  const upserted: string[] = [];

  for (const pattern of detected) {
    const steps = await query<{ action: string; target: object; value: unknown; url: string }>(
      `SELECT action, target, value, url FROM workflow_steps
       WHERE workflow_id = $1 ORDER BY step_index`,
      [pattern.exampleWorkflowId],
    );

    const row = await query<{ id: string }>(
      `INSERT INTO workflow_patterns (user_id, fingerprint, occurrence_count, example_workflow_id, step_template, domains, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, fingerprint) DO UPDATE SET
         occurrence_count = EXCLUDED.occurrence_count,
         last_seen_at = now(),
         step_template = EXCLUDED.step_template
       RETURNING id`,
      [
        userId,
        pattern.fingerprint,
        pattern.occurrenceCount,
        pattern.exampleWorkflowId,
        JSON.stringify(steps),
        pattern.domains,
      ],
    );

    const patternId = row[0].id;
    upserted.push(patternId);

    for (const wfId of pattern.workflowIds) {
      await query(
        `INSERT INTO workflow_pattern_members (pattern_id, workflow_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [patternId, wfId],
      );
      await query(`UPDATE workflows SET status = 'candidate' WHERE id = $1`, [wfId]);
    }
  }

  return {
    patternsFound: upserted.length,
    patternIds: upserted,
    llmMergePairsJudged,
    llmMergePairsMerged,
  };
}

/** Re-segment every session with updated normalizer rules, then re-mine patterns. */
export async function reprocessAllSessions(userId: string): Promise<PipelineRunResult> {
  const sessions = await query<{ id: string }>(
    `SELECT id FROM recording_sessions WHERE user_id = $1 ORDER BY started_at ASC`,
    [userId],
  );

  const sessionIds: string[] = [];
  const workflowIds: string[] = [];
  let workflowsCreated = 0;

  for (const { id } of sessions) {
    const result = await segmentSession(id, userId, { force: true });
    sessionIds.push(id);
    workflowsCreated += result.workflowsCreated;
    workflowIds.push(...result.workflowIds);
  }

  const mine = await minePatterns(userId);

  return {
    sessionsClosed: 0,
    sessionsSegmented: sessionIds.length,
    workflowsCreated,
    patternsFound: mine.patternsFound,
    sessionIds,
    workflowIds,
    patternIds: mine.patternIds,
    llmMergePairsJudged: mine.llmMergePairsJudged,
    llmMergePairsMerged: mine.llmMergePairsMerged,
  };
}

/** Close idle sessions, segment finished ones, then mine patterns. */
export async function runPipeline(userId: string): Promise<PipelineRunResult> {
  const closedByIdle = await closeIdleSessions(userId);

  const pending = await query<{ id: string }>(
    `SELECT id FROM recording_sessions
     WHERE user_id = $1
       AND ended_at IS NOT NULL
       AND segmented_at IS NULL
     ORDER BY ended_at ASC`,
    [userId],
  );

  const sessionIds: string[] = [];
  const workflowIds: string[] = [];
  let workflowsCreated = 0;

  for (const { id } of pending) {
    const result = await segmentSession(id, userId);
    sessionIds.push(id);
    workflowsCreated += result.workflowsCreated;
    workflowIds.push(...result.workflowIds);
  }

  const mine = await minePatterns(userId);

  return {
    sessionsClosed: closedByIdle.length,
    sessionsSegmented: sessionIds.length,
    workflowsCreated,
    patternsFound: mine.patternsFound,
    sessionIds,
    workflowIds,
    patternIds: mine.patternIds,
    llmMergePairsJudged: mine.llmMergePairsJudged,
    llmMergePairsMerged: mine.llmMergePairsMerged,
  };
}
