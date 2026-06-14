import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { query, withTransaction } from './db.js';
import { getModelName, labelPattern, PROMPT_VERSION } from './llm.js';
import {
  endRecordingSession,
  minePatterns,
  reprocessAllSessions,
  segmentSession,
} from './pipeline.js';
import { runPipelineNow, schedulePipelineRun, startPipelineAutoRun } from './pipeline-scheduler.js';
import { listPatterns, listProposals, rejectProposal } from './review.js';
import { getWorkflowReplayEvents } from './replay.js';
import { getCapability } from './executor.js';
import { suggestRepair } from './llm-repair.js';
import { exportPlaywrightScript, runCapability } from '@browser-persona/playwright-executor';

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

/** Run pipeline: close idle sessions → segment → mine patterns. */
app.post('/pipeline/run', async (_req, reply) => {
  const result = await runPipelineNow(DEV_USER_ID, app.log);
  return reply.send(result);
});

/** Re-segment all sessions (force) and re-mine — use after normalizer changes. */
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

/** Mine patterns from raw workflows */
app.post('/patterns/mine', async (_req, reply) => {
  const result = await minePatterns(DEV_USER_ID);
  return reply.send(result);
});

/** Single LLM API call to label a mined pattern */
app.post('/llm/label-workflow', async (req, reply) => {
  const { patternId } = z.object({ patternId: z.string().uuid() }).parse(req.body);

  const patterns = await query<{
    id: string;
    fingerprint: string;
    occurrence_count: number;
    domains: string[];
    step_template: unknown[];
  }>(
    `SELECT id, fingerprint, occurrence_count, domains, step_template
     FROM workflow_patterns WHERE id = $1 AND user_id = $2`,
    [patternId, DEV_USER_ID],
  );

  if (patterns.length === 0) {
    return reply.status(404).send({ error: 'Pattern not found' });
  }

  const pattern = patterns[0];
  const proposal = await labelPattern({
    patternId: pattern.id,
    fingerprint: pattern.fingerprint,
    occurrenceCount: pattern.occurrence_count,
    domains: pattern.domains,
    stepTemplate: pattern.step_template as unknown[],
  });

  const saved = await query<{ id: string }>(
    `INSERT INTO labeling_proposals (workflow_id, pattern_id, proposal, confidence, llm_model, prompt_version)
     SELECT example_workflow_id, $1, $2, $3, $4, $5
     FROM workflow_patterns WHERE id = $1
     RETURNING id`,
    [patternId, JSON.stringify(proposal), proposal.confidence, getModelName(), PROMPT_VERSION],
  );

  return reply.send({
    proposalId: saved[0].id,
    patternId,
    proposal,
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

  const proposals = await query<{
    id: string;
    pattern_id: string;
    proposal: {
      capability_name: string;
      category_path: string[];
      description: string;
      parameters: unknown[];
      confidence: number;
    };
    llm_model: string;
    prompt_version: string;
  }>(`SELECT * FROM labeling_proposals WHERE id = $1`, [body.proposalId]);

  if (proposals.length === 0) {
    return reply.status(404).send({ error: 'Proposal not found' });
  }

  const p = proposals[0];
  const name = body.edits?.name ?? p.proposal.capability_name;
  const categoryPath = body.edits?.category_path ?? p.proposal.category_path;
  const description = body.edits?.description ?? p.proposal.description;

  const patterns = await query<{ step_template: unknown[] }>(
    `SELECT step_template FROM workflow_patterns WHERE id = $1`,
    [p.pattern_id],
  );

  const cap = await query<{ id: string }>(
    `INSERT INTO capabilities (user_id, pattern_id, status, name, description, category_path, parameters, step_template, confidence, llm_model, llm_prompt_version, approved_at, approved_by)
     VALUES ($1, $2, 'approved', $3, $4, $5, $6, $7, $8, $9, $10, now(), $1)
     RETURNING id`,
    [
      DEV_USER_ID,
      p.pattern_id,
      name,
      description,
      categoryPath,
      JSON.stringify(p.proposal.parameters),
      JSON.stringify(patterns[0]?.step_template ?? []),
      p.proposal.confidence,
      p.llm_model,
      p.prompt_version,
    ],
  );

  await query(
    `UPDATE labeling_proposals SET reviewed = true, review_decision = 'approve', reviewed_at = now() WHERE id = $1`,
    [body.proposalId],
  );

  return reply.send({ capabilityId: cap[0].id });
});

/** Inbox: labeling proposals awaiting review */
app.get('/proposals', async (req, reply) => {
  const reviewed = (req.query as { reviewed?: string }).reviewed === 'true';
  const proposals = await listProposals(DEV_USER_ID, reviewed);
  return reply.send({ proposals });
});

/** Mined workflow patterns */
app.get('/patterns', async (_req, reply) => {
  const patterns = await listPatterns(DEV_USER_ID);
  return reply.send({ patterns });
});

/** Workflow-scoped replay events for pattern example playback. */
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
  if (cap.step_template.length === 0) {
    return reply.status(400).send({ error: 'Capability has no steps to run' });
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

  try {
    const result = await runCapability({
      stepTemplate: cap.step_template,
      parameters: body.parameters,
      headless,
      slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO ?? 50),
      timeoutMs: Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? 30_000),
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

    return reply.send({
      capabilityId,
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
