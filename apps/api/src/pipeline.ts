import { segmentSemanticSteps, segmentWorkflows } from '@browser-persona/event-normalizer';
import type { SemanticStep } from '@browser-persona/shared';
import {
  extractIntent,
  getIntentModelName,
  INTENT_PROMPT_VERSION,
} from './llm-intent.js';
import { findIntentDedupMatch, linkWorkflowToCapability } from './intent-dedup.js';
import {
  createCapabilityFromIntent,
  isAutoApproveEligible,
} from './review.js';
import { query } from './db.js';
import { purgeStaleRrwebEvents } from './retention.js';

export const DEFAULT_PIPELINE_IDLE_MS = 90_000;
export const DEFAULT_PIPELINE_INTERVAL_MS = 60_000;

export function getPipelineIdleMs(): number {
  const n = Number(process.env.PIPELINE_IDLE_MS ?? DEFAULT_PIPELINE_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PIPELINE_IDLE_MS;
}

export function getPipelineIntervalMs(): number {
  const n = Number(process.env.PIPELINE_INTERVAL_MS ?? DEFAULT_PIPELINE_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PIPELINE_INTERVAL_MS;
}

export function isIntentExtractAutoEnabled(): boolean {
  if (process.env.INTENT_EXTRACT_AUTO === 'false') return false;
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function shouldSkipNonAutomatableIntent(): boolean {
  return process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE !== 'false';
}

export interface SegmentSessionResult {
  sessionId: string;
  workflowsCreated: number;
  workflowIds: string[];
  intentsExtracted: number;
  intentsDeduped: number;
  intentsAutoApproved: number;
}

export interface PipelineRunResult {
  sessionsClosed: number;
  sessionsSegmented: number;
  workflowsCreated: number;
  intentsExtracted: number;
  intentsDeduped: number;
  intentsAutoApproved: number;
  rrwebPurged?: number;
  sessionIds: string[];
  workflowIds: string[];
}

export interface ExtractIntentResult {
  workflowId: string;
  skipped: boolean;
  reason?:
    | 'non_automatable'
    | 'already_proposed'
    | 'no_api_key'
    | 'disabled'
    | 'deduped'
    | 'auto_approved'
    | 'llm_failed';
  proposalId?: string;
  capabilityId?: string;
  dedupSimilarity?: number;
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


/** Extract intent for one workflow and persist a labeling proposal. */
export async function extractIntentForWorkflow(
  workflowId: string,
  userId: string,
  options?: { force?: boolean },
): Promise<ExtractIntentResult> {
  if (!options?.force && !isIntentExtractAutoEnabled()) {
    return { workflowId, skipped: true, reason: 'disabled' };
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return { workflowId, skipped: true, reason: 'no_api_key' };
  }

  const pending = await query<{ id: string }>(
    `SELECT id FROM intent_proposals
     WHERE workflow_id = $1 AND reviewed = false`,
    [workflowId],
  );
  if (pending.length > 0) {
    return { workflowId, skipped: true, reason: 'already_proposed', proposalId: pending[0].id };
  }

  const intent = await extractIntent(workflowId, userId).catch((err) => {
    console.error(`intent extraction failed for workflow ${workflowId}:`, err);
    return null;
  });
  if (!intent) {
    return { workflowId, skipped: true, reason: 'llm_failed' };
  }

  if (!intent.is_automatable && shouldSkipNonAutomatableIntent()) {
    return { workflowId, skipped: true, reason: 'non_automatable' };
  }

  const dedup = await findIntentDedupMatch(userId, intent);
  if (dedup.matched && dedup.match) {
    await linkWorkflowToCapability(workflowId, dedup.match.capabilityId);
    return {
      workflowId,
      skipped: true,
      reason: 'deduped',
      capabilityId: dedup.match.capabilityId,
      dedupSimilarity: dedup.match.similarity,
    };
  }

  if (isAutoApproveEligible(intent)) {
    const { capabilityId } = await createCapabilityFromIntent(userId, workflowId, intent, {
      confidence: intent.confidence,
      llmModel: getIntentModelName(),
      promptVersion: INTENT_PROMPT_VERSION,
    });
    await query(`UPDATE workflows SET status = 'intent_extracted' WHERE id = $1`, [workflowId]);
    return {
      workflowId,
      skipped: true,
      reason: 'auto_approved',
      capabilityId,
    };
  }

  const saved = await query<{ id: string }>(
    `INSERT INTO intent_proposals (workflow_id, proposal, confidence, llm_model, prompt_version)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      workflowId,
      JSON.stringify(intent),
      intent.confidence,
      getIntentModelName(),
      INTENT_PROMPT_VERSION,
    ],
  );

  await query(`UPDATE workflows SET status = 'intent_extracted' WHERE id = $1`, [workflowId]);

  return {
    workflowId,
    skipped: false,
    proposalId: saved[0].id,
  };
}

export async function extractIntentForWorkflows(
  workflowIds: string[],
  userId: string,
): Promise<{
  extracted: number;
  deduped: number;
  autoApproved: number;
  results: ExtractIntentResult[];
}> {
  const results: ExtractIntentResult[] = [];
  let extracted = 0;
  let deduped = 0;
  let autoApproved = 0;

  for (const workflowId of workflowIds) {
    const result = await extractIntentForWorkflow(workflowId, userId);
    results.push(result);
    if (!result.skipped && result.proposalId) {
      extracted += 1;
    } else if (result.reason === 'deduped') {
      deduped += 1;
    } else if (result.reason === 'auto_approved') {
      autoApproved += 1;
    }
  }

  return { extracted, deduped, autoApproved, results };
}

/** Segment one session into workflows. Idempotent via segmented_at. */
export async function segmentSession(
  sessionId: string,
  userId: string,
  options?: { force?: boolean; extractIntent?: boolean },
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
      intentsExtracted: 0,
      intentsDeduped: 0,
      intentsAutoApproved: 0,
    };
  }

  if (options?.force) {
    await query(`DELETE FROM workflows WHERE session_id = $1`, [sessionId]);
    await query(
      `UPDATE recording_sessions SET segmented_at = NULL WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  }

  const semanticRows = await query<{
    action: string;
    target: object;
    value: unknown;
    url: string | null;
    occurred_at: string;
  }>(
    `SELECT action, target, value, url, occurred_at
     FROM session_semantic_steps WHERE session_id = $1 ORDER BY step_index`,
    [sessionId],
  );

  let segments;
  if (semanticRows.length > 0) {
    const steps: SemanticStep[] = semanticRows.map((r) => ({
      action: r.action as SemanticStep['action'],
      target: r.target as SemanticStep['target'],
      value: r.value as SemanticStep['value'],
      url: r.url ?? undefined,
      occurredAt: r.occurred_at,
    }));
    segments = segmentSemanticSteps(steps);
  } else {
    const rows = await query<{ payload: object; timestamp_ms: number }>(
      `SELECT payload, timestamp_ms FROM rrweb_events
       WHERE session_id = $1 ORDER BY seq ASC`,
      [sessionId],
    );

    const events = rows.map((r) => ({
      ...(r.payload as { type: number; timestamp: number; data?: unknown }),
      timestamp: (r.payload as { timestamp: number }).timestamp ?? r.timestamp_ms,
    }));

    segments = segmentWorkflows(events);
  }
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

  const shouldExtract = options?.extractIntent ?? isIntentExtractAutoEnabled();
  let intentsExtracted = 0;
  let intentsDeduped = 0;
  let intentsAutoApproved = 0;
  if (shouldExtract && created.length > 0) {
    const extract = await extractIntentForWorkflows(created, userId);
    intentsExtracted = extract.extracted;
    intentsDeduped = extract.deduped;
    intentsAutoApproved = extract.autoApproved;
  }

  return {
    sessionId,
    workflowsCreated: created.length,
    workflowIds: created,
    intentsExtracted,
    intentsDeduped,
    intentsAutoApproved,
  };
}

/** Re-segment every session with updated normalizer rules. */
export async function reprocessAllSessions(userId: string): Promise<PipelineRunResult> {
  const sessions = await query<{ id: string }>(
    `SELECT id FROM recording_sessions WHERE user_id = $1 ORDER BY started_at ASC`,
    [userId],
  );

  const sessionIds: string[] = [];
  const workflowIds: string[] = [];
  let workflowsCreated = 0;
  let intentsExtracted = 0;
  let intentsDeduped = 0;
  let intentsAutoApproved = 0;

  for (const { id } of sessions) {
    const result = await segmentSession(id, userId, { force: true });
    sessionIds.push(id);
    workflowsCreated += result.workflowsCreated;
    workflowIds.push(...result.workflowIds);
    intentsExtracted += result.intentsExtracted;
    intentsDeduped += result.intentsDeduped;
    intentsAutoApproved += result.intentsAutoApproved;
  }

  const rrwebPurged = await purgeStaleRrwebEvents().catch(() => 0);

  return {
    sessionsClosed: 0,
    sessionsSegmented: sessionIds.length,
    workflowsCreated,
    intentsExtracted,
    intentsDeduped,
    intentsAutoApproved,
    rrwebPurged,
    sessionIds,
    workflowIds,
  };
}

/** Close idle sessions, segment finished ones, retention purge. */
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
  let intentsExtracted = 0;
  let intentsDeduped = 0;
  let intentsAutoApproved = 0;

  for (const { id } of pending) {
    const result = await segmentSession(id, userId);
    sessionIds.push(id);
    workflowsCreated += result.workflowsCreated;
    workflowIds.push(...result.workflowIds);
    intentsExtracted += result.intentsExtracted;
    intentsDeduped += result.intentsDeduped;
    intentsAutoApproved += result.intentsAutoApproved;
  }

  const rrwebPurged = await purgeStaleRrwebEvents().catch(() => 0);

  return {
    sessionsClosed: closedByIdle.length,
    sessionsSegmented: sessionIds.length,
    workflowsCreated,
    intentsExtracted,
    intentsDeduped,
    intentsAutoApproved,
    rrwebPurged,
    sessionIds,
    workflowIds,
  };
}
