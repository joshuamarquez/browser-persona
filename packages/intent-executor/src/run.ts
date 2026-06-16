import { chromium, type Browser, type Download, type Page } from 'playwright';
import type { IntentRunResult, IntentTask, IntentTaskResult, SemanticAction } from '@browser-persona/shared';
import {
  executeStepWithCheckpoint,
  type StepExecutionContext,
  type TemplateStep,
} from '@browser-persona/playwright-executor';
import { buildInteractiveSnapshot } from './snapshot.js';
import { verifyTask } from './verify.js';

export interface PlanTaskInput {
  task: {
    goal: string;
    verification: string;
  };
  parameters: Record<string, string | number | boolean>;
  currentUrl: string;
  interactiveSnapshot: string;
  previousFailure: string | null;
}

export interface PlanTaskOutput {
  actions: TemplateStep[];
  reasoning: string;
  confidence: number;
}

export type PlanTaskFn = (input: PlanTaskInput) => Promise<PlanTaskOutput>;

export interface RunIntentOptions {
  tasks: IntentTask[];
  parameters?: Record<string, string | number | boolean>;
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
  maxPlanCallsPerTask?: number;
  domSnapshotMaxChars?: number;
  planTask: PlanTaskFn;
  startUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PLAN_CALLS = 3;

function stepToHint(step: TemplateStep): NonNullable<IntentTask['reference_hint']> {
  return {
    action: step.action as SemanticAction,
    target: step.target,
    url: step.url,
  };
}

function planActionsForLearning(actions: TemplateStep[]): NonNullable<IntentTaskResult['learnedPlanActions']> {
  return actions.map((action) => ({
    action: action.action,
    target: action.target,
    url: action.url,
    value:
      action.value === null ||
      typeof action.value === 'string' ||
      typeof action.value === 'number' ||
      typeof action.value === 'boolean'
        ? action.value
        : undefined,
  }));
}

function hintToStep(hint: NonNullable<IntentTask['reference_hint']>): TemplateStep {
  return {
    action: hint.action ?? 'click',
    target: hint.target,
    url: hint.url,
  };
}

function needsDownloadWatch(verification: IntentTask['verification']): boolean {
  return verification.kind === 'download_started';
}

async function executeSteps(
  steps: TemplateStep[],
  ctx: StepExecutionContext,
  watchDownload: boolean,
): Promise<{ ok: boolean; error?: string; pendingDownload?: Promise<Download | null> }> {
  const pendingDownload = watchDownload
    ? ctx.page.waitForEvent('download', { timeout: ctx.timeoutMs }).catch(() => null)
    : undefined;

  for (let i = 0; i < steps.length; i++) {
    const result = await executeStepWithCheckpoint(i, steps[i], ctx);
    if (result.status === 'failed') {
      return { ok: false, error: result.message, pendingDownload };
    }
  }

  return { ok: true, pendingDownload };
}

async function tryVerify(
  task: IntentTask,
  ctx: StepExecutionContext,
  pendingDownload?: Promise<Download | null>,
): Promise<{ passed: boolean; message: string }> {
  return verifyTask(task.verification, {
    page: ctx.page,
    parameters: ctx.parameters,
    timeoutMs: ctx.timeoutMs,
    pendingDownload,
  });
}

async function runSingleTask(
  task: IntentTask,
  page: Page,
  ctx: StepExecutionContext,
  options: RunIntentOptions,
  state: { plannerCalls: number },
): Promise<IntentTaskResult> {
  const maxPlanCalls = options.maxPlanCallsPerTask ?? DEFAULT_MAX_PLAN_CALLS;
  const domCap = options.domSnapshotMaxChars ?? 10_000;

  if (task.risk === 'high' && ctx.parameters.confirm_dangerous !== true) {
    return {
      taskId: task.id,
      goal: task.goal,
      status: 'failed',
      attempts: 0,
      plannerUsed: false,
      message: 'High-risk task requires parameters.confirm_dangerous=true',
    };
  }

  const preCheck = await tryVerify(task, ctx);
  if (preCheck.passed) {
    return {
      taskId: task.id,
      goal: task.goal,
      status: task.optional ? 'skipped' : 'passed',
      attempts: 0,
      plannerUsed: false,
      message: task.optional ? 'Optional task already satisfied' : preCheck.message,
    };
  }

  let attempts = 0;
  let plannerUsed = false;
  let lastFailure = preCheck.message;

  if (task.reference_hint) {
    attempts += 1;
    const watchDownload = needsDownloadWatch(task.verification);
    const exec = await executeSteps([hintToStep(task.reference_hint)], ctx, watchDownload);
    if (exec.ok) {
      const verified = await tryVerify(task, ctx, exec.pendingDownload);
      if (verified.passed) {
        return {
          taskId: task.id,
          goal: task.goal,
          status: 'passed',
          attempts,
          plannerUsed: false,
          message: verified.message,
        };
      }
      lastFailure = verified.message;
    } else {
      lastFailure = exec.error ?? lastFailure;
    }
  }

  let planCalls = 0;
  while (planCalls < maxPlanCalls) {
    planCalls += 1;
    state.plannerCalls += 1;
    plannerUsed = true;
    attempts += 1;

    const snapshot = await buildInteractiveSnapshot(page, domCap);
    let plan: PlanTaskOutput;
    try {
      plan = await options.planTask({
        task: {
          goal: task.goal,
          verification: task.verification.description,
        },
        parameters: ctx.parameters,
        currentUrl: page.url(),
        interactiveSnapshot: snapshot,
        previousFailure: lastFailure,
      });
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (!plan.actions.length) {
      lastFailure = 'Planner returned no actions';
      continue;
    }

    const watchDownload = needsDownloadWatch(task.verification);
    const exec = await executeSteps(plan.actions, ctx, watchDownload);
    if (!exec.ok) {
      lastFailure = exec.error ?? 'Step execution failed';
      continue;
    }

    const verified = await tryVerify(task, ctx, exec.pendingDownload);
    if (verified.passed) {
      return {
        taskId: task.id,
        goal: task.goal,
        status: 'passed',
        attempts,
        plannerUsed,
        message: verified.message,
        learnedHint: plannerUsed ? stepToHint(plan.actions[0]) : undefined,
        learnedPlanActions: plannerUsed ? planActionsForLearning(plan.actions) : undefined,
      };
    }
    lastFailure = verified.message;
  }

  if (task.optional) {
    return {
      taskId: task.id,
      goal: task.goal,
      status: 'skipped',
      attempts,
      plannerUsed,
      message: `Optional task not completed: ${lastFailure}`,
    };
  }

  return {
    taskId: task.id,
    goal: task.goal,
    status: 'failed',
    attempts,
    plannerUsed,
    message: lastFailure,
  };
}

export async function runIntentCapability(options: RunIntentOptions): Promise<IntentRunResult> {
  const taskResults: IntentTaskResult[] = [];
  const state = { plannerCalls: 0 };
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      headless: options.headless ?? false,
      slowMo: options.slowMo ?? 50,
    });
    const page = await browser.newPage();
    const ctx: StepExecutionContext = {
      page,
      parameters: options.parameters ?? {},
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    if (options.startUrl) {
      await page.goto(options.startUrl, {
        timeout: ctx.timeoutMs,
        waitUntil: 'domcontentloaded',
      });
    }

    const sorted = [...options.tasks].sort((a, b) => a.order - b.order);

    for (const task of sorted) {
      const result = await runSingleTask(task, page, ctx, options, state);
      taskResults.push(result);

      if (result.status === 'failed') {
        const domSnapshot = await page.content().catch(() => undefined);
        return {
          success: false,
          taskResults,
          failedAt: task.id,
          domSnapshot: domSnapshot?.slice(0, options.domSnapshotMaxChars ?? 10_000),
          plannerCalls: state.plannerCalls,
          error: result.message,
        };
      }
    }

    return {
      success: true,
      taskResults,
      plannerCalls: state.plannerCalls,
    };
  } catch (err) {
    return {
      success: false,
      taskResults,
      plannerCalls: state.plannerCalls,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export { hintToStep, executeSteps, tryVerify };
