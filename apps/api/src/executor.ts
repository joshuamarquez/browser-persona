import { query } from './db.js';
import type { IntentTask, WorkflowParameter } from '@browser-persona/shared';
import type { TemplateStep } from '@browser-persona/playwright-executor';

export interface CapabilityRecord {
  id: string;
  name: string;
  description: string | null;
  status: string;
  parameters: WorkflowParameter[];
  step_template: TemplateStep[];
  tasks: IntentTask[];
  metadata: Record<string, unknown>;
}

export interface IntentLearningUpdate {
  taskId: string;
  learnedHint?: IntentTask['reference_hint'];
  learnedPlanActions?: unknown[];
}

export function findCapabilityStartUrl(
  tasks: IntentTask[],
  stepTemplate: TemplateStep[],
): string | undefined {
  const sorted = [...tasks].sort((a, b) => a.order - b.order);
  for (const task of sorted) {
    if (task.reference_hint?.url) {
      return task.reference_hint.url;
    }
  }

  for (const step of stepTemplate) {
    if (step.action === 'navigate' && step.url) {
      return step.url;
    }
  }

  return undefined;
}

export async function getCapability(
  capabilityId: string,
  userId: string,
): Promise<CapabilityRecord | null> {
  const rows = await query<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    parameters: WorkflowParameter[];
    step_template: TemplateStep[];
    tasks: IntentTask[];
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, name, description, status, parameters, step_template, tasks, metadata
     FROM capabilities WHERE id = $1 AND user_id = $2`,
    [capabilityId, userId],
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  };
}

export async function persistIntentLearning(
  capabilityId: string,
  userId: string,
  updates: IntentLearningUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  const cap = await getCapability(capabilityId, userId);
  if (!cap) return;

  const tasks = [...cap.tasks];
  const metadata = { ...cap.metadata };
  const planCache =
    metadata.plan_cache && typeof metadata.plan_cache === 'object'
      ? { ...(metadata.plan_cache as Record<string, unknown>) }
      : {};

  for (const update of updates) {
    const taskIndex = tasks.findIndex((t) => t.id === update.taskId);
    if (taskIndex < 0) continue;

    if (update.learnedHint) {
      tasks[taskIndex] = {
        ...tasks[taskIndex],
        reference_hint: update.learnedHint,
      };
    }

    if (update.learnedPlanActions?.length) {
      const existing = Array.isArray(planCache[update.taskId])
        ? (planCache[update.taskId] as unknown[])
        : [];
      planCache[update.taskId] = [...existing, update.learnedPlanActions];
    }
  }

  metadata.plan_cache = planCache;

  await query(
    `UPDATE capabilities SET tasks = $1, metadata = $2 WHERE id = $3 AND user_id = $4`,
    [JSON.stringify(tasks), JSON.stringify(metadata), capabilityId, userId],
  );
}
