import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { query, withTransaction } from './db.js';
import {
  endRecordingSession,
  extractIntentForWorkflow,
  reprocessAllSessions,
  segmentSession,
} from './pipeline.js';
import { runPipelineNow, schedulePipelineRun, startPipelineAutoRun } from './pipeline-scheduler.js';
import { approveProposal, listIntentWorkflows, listProposals, rejectProposal } from './review.js';
import { extractIntent, getIntentModelName, INTENT_PROMPT_VERSION } from './llm-intent.js';
import { getWorkflowReplayEvents } from './replay.js';
import { getCapability, findCapabilityStartUrl, persistIntentLearning } from './executor.js';
import { suggestRepair } from './llm-repair.js';
import { planTask } from './llm-plan.js';
import { exportPlaywrightScript, runCapability } from '@browser-persona/playwright-executor';
import { runIntentCapability } from '@browser-persona/intent-executor';
import { getAutomationOffersForSession } from './automation-offers.js';
import { listCapabilityRuns, recordCapabilityRun } from './capability-runs.js';

const DEFAULT_INGEST_BODY_LIMIT_MB = 25;

function getIngestBodyLimitBytes(): number {
  const mb = Number(process.env.INGEST_BODY_LIMIT_MB ?? DEFAULT_INGEST_BODY_LIMIT_MB);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_INGEST_BODY_LIMIT_MB * 1024 * 1024;
  return mb * 1024 * 1024;
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const DEV_USER_ID = process.env.DEV_USER_ID ?? '00000000-0000-0000-0000-000000000001';
const ingestBodyLimit = getIngestBodyLimitBytes();

const IngestSchema = z.object({
  sessionId: z.string().uuid(),
  events: z.array(
    z.object({
      type: z.number(),
      timestamp: z.number(),
      data: z.unknown().optional(),
    }),
  ),
  meta: z.object({
    url: z.string(),
    tabId: z.number().optional(),
    title: z.string().optional(),
  }),
});

app.get('/health', async () => ({ ok: true }));

/** Batch ingest rrweb events from extension */
app.post('/ingest/events', { bodyLimit: ingestBodyLimit }, async (req, reply) => {
  const body = IngestSchema.parse(req.body);

  const accepted = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO recording_sessions (id, user_id, started_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO NOTHING`,
      [body.sessionId, DEV_USER_ID],
    );

    // Serialize concurrent ingests for the same session (unique on session_id + seq).
    await client.query(`SELECT id FROM recording_sessions WHERE id = $1 FOR UPDATE`, [
      body.sessionId,
    ]);

    const startSeq = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM rrweb_events WHERE session_id = $1`,
      [body.sessionId],
    );
    let seq = startSeq.rows[0]?.next ?? 0;

    for (const event of body.events) {
      await client.query(
        `INSERT INTO rrweb_events (session_id, seq, event_type, timestamp_ms, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [body.sessionId, seq++, event.type, event.timestamp, JSON.stringify(event)],
      );
    }

    return body.events.length;
  });

  return reply.send({ accepted, sessionId: body.sessionId });
});

const SemanticStepSchema = z.object({
  action: z.enum(['navigate', 'click', 'fill', 'select', 'scroll', 'submit', 'wait']),
  target: z.record(z.unknown()).optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  url: z.string().optional(),
  occurredAt: z.string(),
});

const SemanticIngestSchema = z.object({
  sessionId: z.string().uuid(),
  steps: z.array(SemanticStepSchema).min(1),
  meta: z.object({
    url: z.string(),
    tabId: z.number().optional(),
    title: z.string().optional(),
    captureMode: z.literal('semantic').optional(),
  }),
});

/** Compact semantic steps from extension (captureMode=semantic; no rrweb). */
app.post('/ingest/semantic-steps', async (req, reply) => {
  const body = SemanticIngestSchema.parse(req.body);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO recording_sessions (id, user_id, started_at, metadata)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (id) DO UPDATE SET metadata = recording_sessions.metadata || EXCLUDED.metadata`,
      [
        body.sessionId,
        DEV_USER_ID,
        JSON.stringify({ capture_mode: 'semantic', last_url: body.meta.url }),
      ],
    );

    await client.query(`SELECT id FROM recording_sessions WHERE id = $1 FOR UPDATE`, [
      body.sessionId,
    ]);

    const startIdx = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(step_index), -1) + 1 AS next FROM session_semantic_steps WHERE session_id = $1`,
      [body.sessionId],
    );
    let stepIndex = startIdx.rows[0]?.next ?? 0;

    for (const step of body.steps) {
      await client.query(
        `INSERT INTO session_semantic_steps (session_id, step_index, action, target, value, url, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          body.sessionId,
          stepIndex++,
          step.action,
          JSON.stringify(step.target ?? {}),
          step.value != null ? JSON.stringify(step.value) : null,
          step.url ?? null,
          step.occurredAt,
        ],
      );
    }
  });

  return reply.send({ accepted: body.steps.length, sessionId: body.sessionId });
});

/** Automation offers for a session (extension notification after pipeline). */
app.get('/sessions/:sessionId/automation-offers', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const exists = await query<{ id: string }>(
    `SELECT id FROM recording_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, DEV_USER_ID],
  );
  if (exists.length === 0) {
    return reply.status(404).send({ error: 'Session not found' });
  }
  const offers = await getAutomationOffersForSession(sessionId, DEV_USER_ID);
  return reply.send({ sessionId, offers });
});

/** Mark a recording session as ended (extension tab close). */
app.post('/sessions/:sessionId/end', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };

  const ended = await endRecordingSession(sessionId, DEV_USER_ID);
  if (!ended) {
    const exists = await query<{ id: string }>(
      `SELECT id FROM recording_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, DEV_USER_ID],
    );
    if (exists.length === 0) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return reply.send({ sessionId, ended: false, alreadyEnded: true });
  }

  schedulePipelineRun(DEV_USER_ID, app.log);
  return reply.send({ sessionId, ended: true });
});

/** Run pipeline: close idle sessions → segment → extract intent. */
app.post('/pipeline/run', async (_req, reply) => {
  const result = await runPipelineNow(DEV_USER_ID, app.log);
  return reply.send(result);
});

/** Re-segment all sessions (force) — use after normalizer changes. */
app.post('/pipeline/reprocess', async (_req, reply) => {
  const result = await reprocessAllSessions(DEV_USER_ID);
  return reply.send(result);
});

/** Segment a session into workflows and persist semantic steps */
app.post('/workflows/segment/:sessionId', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const force = (req.query as { force?: string }).force === 'true';

  try {
    const result = await segmentSession(sessionId, DEV_USER_ID, { force });
    return reply.send({
      sessionId: result.sessionId,
      workflowsCreated: result.workflowsCreated,
      workflowIds: result.workflowIds,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Session not found') {
      return reply.status(404).send({ error: 'Session not found' });
    }
    throw err;
  }
});

/** Manual intent extraction for one workflow */
app.post('/workflows/:workflowId/extract-intent', async (req, reply) => {
  const { workflowId } = req.params as { workflowId: string };

  const exists = await query<{ id: string }>(
    `SELECT id FROM workflows WHERE id = $1 AND user_id = $2`,
    [workflowId, DEV_USER_ID],
  );
  if (exists.length === 0) {
    return reply.status(404).send({ error: 'Workflow not found' });
  }

  try {
    const intent = await extractIntent(workflowId, DEV_USER_ID);
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

    return reply.send({
      proposalId: saved[0].id,
      workflowId,
      proposal: intent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('OPENAI_API_KEY')) {
      return reply.status(503).send({ error: message });
    }
    throw err;
  }
});

/** LLM extract intent alias */
app.post('/llm/extract-intent', async (req, reply) => {
  const { workflowId } = z.object({ workflowId: z.string().uuid() }).parse(req.body);

  const exists = await query<{ id: string }>(
    `SELECT id FROM workflows WHERE id = $1 AND user_id = $2`,
    [workflowId, DEV_USER_ID],
  );
  if (exists.length === 0) {
    return reply.status(404).send({ error: 'Workflow not found' });
  }

  const result = await extractIntentForWorkflow(workflowId, DEV_USER_ID, { force: true });
  if (result.skipped && result.reason === 'non_automatable') {
    return reply.send({
      workflowId,
      skipped: true,
      reason: result.reason,
      message: 'Workflow marked as not automatable; no proposal created',
    });
  }
  if (result.skipped && result.reason === 'already_proposed') {
    return reply.send({
      workflowId,
      skipped: true,
      reason: result.reason,
      proposalId: result.proposalId,
    });
  }
  if (result.skipped) {
    return reply.status(503).send({
      error: result.reason === 'no_api_key' ? 'OPENAI_API_KEY is not configured' : 'Intent extraction disabled',
      reason: result.reason,
    });
  }

  const proposals = await query<{ proposal: unknown }>(
    `SELECT proposal FROM intent_proposals WHERE id = $1`,
    [result.proposalId],
  );

  return reply.send({
    proposalId: result.proposalId,
    workflowId,
    proposal: proposals[0]?.proposal,
  });
});

/** Human review: approve proposal -> capability */
app.post('/capabilities/approve', async (req, reply) => {
  const body = z
    .object({
      proposalId: z.string().uuid(),
      edits: z
        .object({
          name: z.string().optional(),
          category_path: z.array(z.string()).optional(),
          description: z.string().optional(),
        })
        .optional(),
    })
    .parse(req.body);

  try {
    const result = await approveProposal(body.proposalId, DEV_USER_ID, body.edits);
    return reply.send(result);
  } catch (err) {
    if (err instanceof Error && err.message === 'Proposal not found') {
      return reply.status(404).send({ error: 'Proposal not found' });
    }
    throw err;
  }
});

/** Inbox: labeling proposals awaiting review */
app.get('/proposals', async (req, reply) => {
  const reviewed = (req.query as { reviewed?: string }).reviewed === 'true';
  const proposals = await listProposals(DEV_USER_ID, reviewed);
  return reply.send({ proposals });
});

/** Intent-extracted workflows */
app.get('/workflows/intent', async (_req, reply) => {
  const workflows = await listIntentWorkflows(DEV_USER_ID);
  return reply.send({ workflows });
});

/** Workflow-scoped replay events for review UI playback. */
app.get('/workflows/:workflowId/replay-events', async (req, reply) => {
  const { workflowId } = req.params as { workflowId: string };
  try {
    const result = await getWorkflowReplayEvents(workflowId, DEV_USER_ID);
    return reply.send(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Workflow not found') {
        return reply.status(404).send({ error: 'Workflow not found' });
      }
      if (
        err.message.includes('No replay events') ||
        err.message.includes('No DOM snapshot')
      ) {
        return reply.status(404).send({ error: err.message });
      }
    }
    throw err;
  }
});

/** Reject a labeling proposal */
app.post('/proposals/:proposalId/reject', async (req, reply) => {
  const { proposalId } = req.params as { proposalId: string };
  const rejected = await rejectProposal(proposalId, DEV_USER_ID);
  if (!rejected) {
    return reply.status(404).send({ error: 'Proposal not found or already reviewed' });
  }
  return reply.send({ proposalId, rejected: true });
});

/** List capabilities grouped by category (review UI feed) */
app.get('/capabilities', async (_req, reply) => {
  const caps = await query<{
    id: string;
    name: string;
    description: string;
    category_path: string[];
    confidence: number;
    status: string;
    parameters: unknown[];
  }>(
    `SELECT id, name, description, category_path, confidence, status, parameters
     FROM capabilities WHERE user_id = $1 ORDER BY category_path, name`,
    [DEV_USER_ID],
  );
  return reply.send({ capabilities: caps });
});

/** Capability run history */
app.get('/capabilities/runs', async (req, reply) => {
  const capabilityId = (req.query as { capabilityId?: string }).capabilityId;
  const runs = await listCapabilityRuns(DEV_USER_ID, { capabilityId, limit: 50 });
  return reply.send({ runs });
});

/** Full capability detail for export/run */
app.get('/capabilities/:capabilityId', async (req, reply) => {
  const { capabilityId } = req.params as { capabilityId: string };
  const cap = await getCapability(capabilityId, DEV_USER_ID);
  if (!cap) {
    return reply.status(404).send({ error: 'Capability not found' });
  }
  return reply.send({ capability: cap });
});

/** Export approved capability as a runnable Playwright script */
app.get('/capabilities/:capabilityId/playwright', async (req, reply) => {
  const { capabilityId } = req.params as { capabilityId: string };
  const cap = await getCapability(capabilityId, DEV_USER_ID);
  if (!cap) {
    return reply.status(404).send({ error: 'Capability not found' });
  }
  if (cap.status !== 'approved') {
    return reply.status(400).send({ error: 'Only approved capabilities can be exported' });
  }

  const script = exportPlaywrightScript({
    capabilityId: cap.id,
    capabilityName: cap.name,
    description: cap.description ?? undefined,
    stepTemplate: cap.step_template,
    parameters: cap.parameters,
  });

  const slug = cap.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return reply
    .header('Content-Type', 'text/typescript; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${slug || 'capability'}.playwright.ts"`)
    .send(script);
});

/** Run capability headfully with per-step validation checkpoints */
app.post('/capabilities/:capabilityId/run', async (req, reply) => {
  const { capabilityId } = req.params as { capabilityId: string };
  const body = z
    .object({
      parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      headless: z.boolean().optional(),
      suggestRepair: z.boolean().optional(),
    })
    .parse(req.body ?? {});

  const cap = await getCapability(capabilityId, DEV_USER_ID);
  if (!cap) {
    return reply.status(404).send({ error: 'Capability not found' });
  }
  if (cap.status !== 'approved') {
    return reply.status(400).send({ error: 'Only approved capabilities can be executed' });
  }

  const inDocker = process.env.DOCKER_CONTAINER === 'true';
  const wantsHeadful =
    body.headless === false ||
    (body.headless === undefined && process.env.PLAYWRIGHT_HEADLESS !== 'true');

  if (inDocker && wantsHeadful) {
    return reply.status(400).send({
      error:
        'Headful execution needs the API on your host — a visible browser cannot open from inside Docker on macOS. Stop the API container and run: npm run docker:exec',
      hint: 'docker:exec',
    });
  }

  const headless = body.headless ?? (inDocker || process.env.PLAYWRIGHT_HEADLESS === 'true');
  const slowMo = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 50);
  const timeoutMs = Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? 30_000);
  const runStartedAt = new Date();

  if (cap.tasks.length > 0) {
    try {
      const result = await runIntentCapability({
        tasks: cap.tasks,
        parameters: body.parameters,
        headless,
        slowMo,
        timeoutMs,
        maxPlanCallsPerTask: Number(process.env.INTENT_RUN_MAX_PLAN_CALLS_PER_TASK ?? 3),
        domSnapshotMaxChars: Number(process.env.INTENT_DOM_SNAPSHOT_MAX_CHARS ?? 10_000),
        startUrl: findCapabilityStartUrl(cap.tasks, cap.step_template),
        planTask: (input) =>
          planTask({
            capabilityName: cap.name,
            ...input,
          }),
      });

      if (result.success && result.taskResults?.length) {
        const learning = result.taskResults
          .filter((tr) => tr.plannerUsed && tr.learnedHint)
          .map((tr) => ({
            taskId: tr.taskId,
            learnedHint: tr.learnedHint,
            learnedPlanActions: tr.learnedPlanActions,
          }));
        if (learning.length > 0) {
          await persistIntentLearning(capabilityId, DEV_USER_ID, learning);
        }
      }

      const runId = await recordCapabilityRun({
        capabilityId,
        userId: DEV_USER_ID,
        status: result.success ? 'success' : 'failed',
        parameters: body.parameters,
        taskResults: result.taskResults,
        plannerCalls: result.plannerCalls,
        errorMessage: result.success ? undefined : result.taskResults?.find((t) => t.status === 'failed')?.message,
        startedAt: runStartedAt,
      });

      return reply.send({
        capabilityId,
        runId,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Executable doesn') || message.includes('browserType.launch')) {
        const error = inDocker
          ? 'Playwright browsers are missing in the API container. Rebuild with: docker compose up --build -d api. For a visible browser on macOS, run: npm run docker:exec'
          : 'Playwright browsers are not installed on this machine. Run: npm run playwright:install';
        return reply.status(503).send({ error });
      }
      throw err;
    }
  }

  if (cap.step_template.length === 0) {
    return reply.status(400).send({ error: 'Capability has no steps or tasks to run' });
  }

  try {
    const result = await runCapability({
      stepTemplate: cap.step_template,
      parameters: body.parameters,
      headless,
      slowMo,
      timeoutMs,
    });

    let repair = undefined;
    if (
      !result.success &&
      body.suggestRepair !== false &&
      result.failedAt != null &&
      result.domSnapshot
    ) {
      try {
        repair = await suggestRepair({
          capabilityName: cap.name,
          failedStepIndex: result.failedAt,
          failedStep: cap.step_template[result.failedAt],
          errorMessage: result.error ?? 'Step failed',
          domSnapshot: result.domSnapshot,
        });
      } catch (repairErr) {
        app.log.warn(repairErr, 'repair suggestion failed');
      }
    }

    const runId = await recordCapabilityRun({
      capabilityId,
      userId: DEV_USER_ID,
      status: result.success ? 'success' : 'failed',
      parameters: body.parameters,
      errorMessage: result.error,
      startedAt: runStartedAt,
    });

    return reply.send({
      capabilityId,
      runId,
      ...result,
      repair,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Executable doesn') || message.includes('browserType.launch')) {
      const error = inDocker
        ? 'Playwright browsers are missing in the API container. Rebuild with: docker compose up --build -d api. For a visible browser on macOS, run: npm run docker:exec'
        : 'Playwright browsers are not installed on this machine. Run: npm run playwright:install';
      return reply.status(503).send({ error });
    }
    throw err;
  }
});

startPipelineAutoRun(DEV_USER_ID, app.log);

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
