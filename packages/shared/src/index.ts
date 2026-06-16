// Shared types for capture, normalization, and LLM labeling

/** Minimal rrweb event shape — store full payload in DB */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export type SemanticAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'scroll'
  | 'submit'
  | 'wait';

export interface StepTarget {
  /** CSS selector if stable */
  selector?: string;
  /** Accessible name / visible text fallback */
  text?: string;
  role?: string;
  ariaLabel?: string;
  name?: string;
  tag?: string;
}

export interface SemanticStep {
  action: SemanticAction;
  target?: StepTarget;
  value?: string | number | boolean | null;
  url?: string;
  occurredAt: string; // ISO
}

export interface WorkflowParameter {
  name: string;
  type: 'string' | 'date' | 'number' | 'enum' | 'boolean';
  description?: string;
  values?: string[];
  example?: string;
}

export type TaskRisk = 'low' | 'medium' | 'high';

export type VerificationKind =
  | 'url_matches'
  | 'url_contains'
  | 'element_visible'
  | 'element_state'
  | 'download_started'
  | 'network_idle'
  | 'custom_assert';

export interface TaskVerification {
  kind: VerificationKind;
  description: string;
  spec?: {
    urlPattern?: string;
    role?: string;
    name?: string;
    text?: string;
    selector?: string;
    value?: string | boolean;
  };
}

export interface IntentTask {
  id: string;
  order: number;
  goal: string;
  reference_hint?: {
    action?: SemanticAction;
    target?: StepTarget;
    url?: string;
  };
  verification: TaskVerification;
  risk: TaskRisk;
  optional?: boolean;
}

export interface IntentWorkflow {
  name: string;
  description: string;
  category_path: string[];
  domain: string;
  parameters: WorkflowParameter[];
  tasks: IntentTask[];
  is_automatable: boolean;
  confidence: number;
  reasoning: string;
}

const TASK_RISKS: TaskRisk[] = ['low', 'medium', 'high'];
const VERIFICATION_KINDS: VerificationKind[] = [
  'url_matches',
  'url_contains',
  'element_visible',
  'element_state',
  'download_started',
  'network_idle',
  'custom_assert',
];

export function isTaskRisk(value: unknown): value is TaskRisk {
  return typeof value === 'string' && TASK_RISKS.includes(value as TaskRisk);
}

export function isVerificationKind(value: unknown): value is VerificationKind {
  return typeof value === 'string' && VERIFICATION_KINDS.includes(value as VerificationKind);
}

export function isIntentWorkflow(value: unknown): value is IntentWorkflow {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.category_path) &&
    typeof v.domain === 'string' &&
    Array.isArray(v.parameters) &&
    Array.isArray(v.tasks) &&
    typeof v.is_automatable === 'boolean' &&
    typeof v.confidence === 'number' &&
    typeof v.reasoning === 'string'
  );
}

/** Max task risk for capability-level safety tier. */
export function maxTaskRisk(tasks: IntentTask[]): TaskRisk {
  if (tasks.some((t) => t.risk === 'high')) return 'high';
  if (tasks.some((t) => t.risk === 'medium')) return 'medium';
  return 'low';
}

export type IntentTaskResultStatus = 'passed' | 'failed' | 'skipped';

export interface IntentTaskResult {
  taskId: string;
  goal: string;
  status: IntentTaskResultStatus;
  attempts: number;
  plannerUsed: boolean;
  message: string;
  learnedHint?: IntentTask['reference_hint'];
  learnedPlanActions?: Array<{
    action: string;
    target?: StepTarget;
    url?: string;
    value?: string | number | boolean | null;
  }>;
}

export interface IntentRunResult {
  success: boolean;
  taskResults: IntentTaskResult[];
  failedAt?: string;
  domSnapshot?: string;
  plannerCalls?: number;
  error?: string;
}
