import OpenAI from 'openai';
import { z } from 'zod';
import type { IntentTask, IntentWorkflow, SemanticAction, StepTarget } from '@browser-persona/shared';
import { compactWorkflowSteps } from './compact-steps.js';
import { query } from './db.js';

export const INTENT_PROMPT_VERSION = process.env.INTENT_PROMPT_VERSION ?? 'v1';

const ParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'date', 'number', 'enum', 'boolean']),
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
  example: z.string().optional(),
});

function normalizeParameterEntry(item: unknown): unknown {
  if (typeof item === 'string') {
    return { name: item, type: 'string' };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.name === 'string') return item;
  }
  return item;
}

function normalizeParameters(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeParameterEntry);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([name, spec]) => {
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        return { name, ...(spec as Record<string, unknown>) };
      }
      return { name, type: 'string', example: spec != null ? String(spec) : undefined };
    });
  }
  return [];
}

const VERIFICATION_KIND_ALIASES: Record<string, string> = {
  url_equals: 'url_matches',
  url_match: 'url_matches',
  url_includes: 'url_contains',
  url_include: 'url_contains',
  element_exists: 'element_visible',
  visible: 'element_visible',
};

function normalizeVerificationKind(value: unknown): unknown {
  if (typeof value === 'string' && value in VERIFICATION_KIND_ALIASES) {
    return VERIFICATION_KIND_ALIASES[value];
  }
  return value;
}

const ReferenceHintSchema = z.object({
  action: z
    .enum(['navigate', 'click', 'fill', 'select', 'scroll', 'submit', 'wait'])
    .optional(),
  target: z
    .object({
      selector: z.string().optional(),
      text: z.string().optional(),
      role: z.string().optional(),
      ariaLabel: z.string().optional(),
      name: z.string().optional(),
      tag: z.string().optional(),
    })
    .optional(),
  url: z.string().optional(),
});

const TaskVerificationSchema = z.object({
  kind: z.preprocess(
    normalizeVerificationKind,
    z.enum([
    'url_matches',
    'url_contains',
    'element_visible',
    'element_state',
    'download_started',
    'network_idle',
    'custom_assert',
    ]),
  ),
  description: z.string(),
  spec: z
    .object({
      urlPattern: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
      selector: z.string().optional(),
      value: z.union([z.string(), z.boolean()]).optional(),
    })
    .optional(),
});

const IntentTaskLlmSchema = z.object({
  id: z.string(),
  order: z.number(),
  goal: z.string(),
  reference_step_index: z.number().int().min(0).optional(),
  reference_hint: ReferenceHintSchema.optional(),
  verification: TaskVerificationSchema,
  risk: z.enum(['low', 'medium', 'high']),
  optional: z.boolean().optional(),
});

export const IntentWorkflowLlmSchema = z.object({
  name: z.string(),
  description: z.string(),
  category_path: z.array(z.string()).min(1),
  domain: z.string(),
  parameters: z.preprocess(normalizeParameters, z.array(ParameterSchema)),
  tasks: z.array(IntentTaskLlmSchema).min(1),
  is_automatable: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type IntentWorkflowLlmOutput = z.infer<typeof IntentWorkflowLlmSchema>;

const SYSTEM_PROMPT = `You extract browser workflow intent from recorded semantic steps.

Rules:
- Collapse noise (scrolls, stray clicks) into fewer outcome-oriented tasks
- Goals describe what the user achieves, not CSS selectors or mechanics
- Every task needs a verification object where possible
- Tag risk "high" for payment, delete, send, publish, or logout actions
- Set is_automatable=false for aimless browsing, incomplete journeys, or pure exploration
- parameters: only values that would change on rerun (dates, names, IDs) — use a JSON array of objects with name and type, e.g. [{"name":"start_date","type":"date"}]
- verification.kind must be one of: url_matches, url_contains, element_visible, element_state, download_started, network_idle, custom_assert (not url_equals)
- Never include passwords or secrets in parameters or goals
- reference_step_index: optional index into the provided steps array for the best matching action
- Return strict JSON matching the schema

Example task shape:
{
  "id": "t1",
  "order": 1,
  "goal": "Open the Reports area",
  "reference_step_index": 0,
  "verification": {
    "kind": "url_contains",
    "description": "URL includes /reports",
    "spec": {"urlPattern": "/reports"}
  },
  "risk": "low"
}`;

export interface WorkflowStepRow {
  action: string;
  target: object;
  value: unknown;
  url: string | null;
}

function hintFromStep(row: WorkflowStepRow): IntentTask['reference_hint'] {
  const target = row.target as StepTarget;
  const action = row.action as SemanticAction;
  if (action === 'navigate') {
    return { action, url: row.url ?? undefined };
  }
  return {
    action,
    target: Object.keys(target ?? {}).length > 0 ? target : undefined,
    url: row.url ?? undefined,
  };
}

/** Resolve LLM reference_step_index / partial hints into full reference_hint objects. */
export function mapReferenceHints(
  intent: IntentWorkflowLlmOutput,
  steps: WorkflowStepRow[],
): IntentWorkflow {
  const tasks: IntentTask[] = intent.tasks.map((task) => {
    let referenceHint = task.reference_hint;

    if (task.reference_step_index != null && steps[task.reference_step_index]) {
      referenceHint = hintFromStep(steps[task.reference_step_index]);
    } else if (!referenceHint && steps.length > 0) {
      const idx = Math.min(task.order - 1, steps.length - 1);
      if (idx >= 0) {
        referenceHint = hintFromStep(steps[idx]);
      }
    }

    return {
      id: task.id,
      order: task.order,
      goal: task.goal,
      reference_hint: referenceHint,
      verification: task.verification,
      risk: task.risk,
      optional: task.optional,
    };
  });

  return {
    name: intent.name,
    description: intent.description,
    category_path: intent.category_path,
    domain: intent.domain,
    parameters: intent.parameters,
    tasks,
    is_automatable: intent.is_automatable,
    confidence: intent.confidence,
    reasoning: intent.reasoning,
  };
}

export function parseIntentWorkflowLlm(raw: string): IntentWorkflowLlmOutput {
  return IntentWorkflowLlmSchema.parse(JSON.parse(raw));
}

export interface ExtractIntentInput {
  workflowId: string;
  domain: string;
  durationSec: number;
  steps: WorkflowStepRow[];
}

export async function extractIntentFromSteps(input: ExtractIntentInput): Promise<IntentWorkflow> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const userPayload = {
    workflow_id: input.workflowId,
    domain: input.domain,
    duration_sec: input.durationSec,
    steps: compactWorkflowSteps(input.steps),
  };

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Extract intent from this workflow recording. Return JSON with keys: name, description, category_path, domain, parameters (array), tasks (array), is_automatable, confidence, reasoning.\n\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty LLM response');
  }

  const parsed = parseIntentWorkflowLlm(raw);
  return mapReferenceHints(parsed, input.steps);
}

export async function extractIntent(workflowId: string, userId: string): Promise<IntentWorkflow> {
  const workflows = await query<{
    id: string;
    primary_domain: string | null;
    started_at: string;
    ended_at: string;
  }>(
    `SELECT id, primary_domain, started_at, ended_at
     FROM workflows WHERE id = $1 AND user_id = $2`,
    [workflowId, userId],
  );

  if (workflows.length === 0) {
    throw new Error('Workflow not found');
  }

  const wf = workflows[0];
  const steps = await query<WorkflowStepRow>(
    `SELECT action, target, value, url FROM workflow_steps
     WHERE workflow_id = $1 ORDER BY step_index`,
    [workflowId],
  );

  const started = new Date(wf.started_at).getTime();
  const ended = new Date(wf.ended_at).getTime();
  const durationSec = Math.max(1, Math.round((ended - started) / 1000));

  return extractIntentFromSteps({
    workflowId,
    domain: wf.primary_domain ?? 'unknown',
    durationSec,
    steps,
  });
}

export function getIntentModelName(): string {
  return process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
}
