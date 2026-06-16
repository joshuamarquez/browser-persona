export interface WorkflowParameter {
  name: string;
  type: string;
  description?: string;
  example?: string;
}

export type TaskRisk = 'low' | 'medium' | 'high';

export interface TaskVerification {
  kind: string;
  description: string;
  spec?: Record<string, unknown>;
}

export interface IntentTask {
  id: string;
  order: number;
  goal: string;
  verification: TaskVerification;
  risk: TaskRisk;
  optional?: boolean;
}

export interface IntentProposal {
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

export function proposalDisplayName(proposal: IntentProposal): string {
  return proposal.name;
}

export interface Proposal {
  id: string;
  workflow_id: string;
  proposal: IntentProposal;
  confidence: number;
  created_at: string;
  domains: string[] | null;
  step_template: StepTemplate[] | null;
}

export interface StepTemplate {
  action: string;
  target?: Record<string, unknown>;
  value?: unknown;
  url?: string;
}

export interface IntentWorkflowSummary {
  id: string;
  primary_domain: string;
  status: string;
  created_at: string;
  has_pending_proposal: boolean;
  linked_capability_id: string | null;
}

export interface RrwebReplayEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface ReplayEventsResponse {
  sessionId: string;
  workflowId?: string;
  eventCount: number;
  events: RrwebReplayEvent[];
}

export interface CapabilityRun {
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

export interface Capability {
  id: string;
  name: string;
  description: string;
  category_path: string[];
  confidence: number;
  status: string;
  parameters?: WorkflowParameter[];
}

export interface CapabilityDetail extends Capability {
  step_template: StepTemplate[];
}

export interface CheckpointResult {
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed';
  message: string;
  durationMs: number;
}

export interface RepairSuggestion {
  diagnosis: string;
  suggested_step_patch?: {
    target?: Record<string, string>;
    value?: unknown;
    wait_ms?: number;
  };
  confidence: number;
  reasoning: string;
}

export interface IntentTaskResult {
  taskId: string;
  goal: string;
  status: 'passed' | 'failed' | 'skipped';
  attempts: number;
  plannerUsed: boolean;
  message: string;
}

export interface RunCapabilityResult {
  capabilityId: string;
  success: boolean;
  checkpoints?: CheckpointResult[];
  taskResults?: IntentTaskResult[];
  plannerCalls?: number;
  failedAt?: number | string;
  domSnapshot?: string;
  error?: string;
  repair?: RepairSuggestion;
}
