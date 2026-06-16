import type { FastifyBaseLogger } from 'fastify';
import { getPipelineIntervalMs, runPipeline, type PipelineRunResult } from './pipeline.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
let debounceId: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<PipelineRunResult> | null = null;

function logPipelineResult(logger: FastifyBaseLogger, result: PipelineRunResult): void {
  if (
    result.sessionsClosed > 0 ||
    result.sessionsSegmented > 0 ||
    result.workflowsCreated > 0 ||
    result.intentsExtracted > 0
  ) {
    logger.info(result, 'pipeline run completed');
  }
}

export function runPipelineNow(userId: string, logger: FastifyBaseLogger): Promise<PipelineRunResult> {
  if (inFlight) return inFlight;

  inFlight = runPipeline(userId)
    .then((result) => {
      logPipelineResult(logger, result);
      return result;
    })
    .catch((err) => {
      logger.error(err, 'pipeline run failed');
      return {
        sessionsClosed: 0,
        sessionsSegmented: 0,
        workflowsCreated: 0,
        intentsExtracted: 0,
        intentsDeduped: 0,
        intentsAutoApproved: 0,
        sessionIds: [],
        workflowIds: [],
      };
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Debounced run after a session ends so intents appear without waiting for the interval. */
export function schedulePipelineRun(userId: string, logger: FastifyBaseLogger): void {
  if (debounceId != null) clearTimeout(debounceId);
  debounceId = setTimeout(() => {
    debounceId = null;
    void runPipelineNow(userId, logger);
  }, 5_000);
}

export function startPipelineAutoRun(userId: string, logger: FastifyBaseLogger): void {
  if (process.env.PIPELINE_AUTO_RUN === 'false') {
    logger.info('pipeline auto-run disabled');
    return;
  }

  const intervalMs = getPipelineIntervalMs();
  const tick = () => {
    void runPipelineNow(userId, logger);
  };

  tick();
  intervalId = setInterval(tick, intervalMs);
  logger.info({ intervalMs }, 'pipeline auto-run enabled');
}
