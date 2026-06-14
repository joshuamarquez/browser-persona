export interface WorkflowParameter {
  name: string;
  type: string;
  description?: string;
  example?: string;
}

export interface LabelProposal {
  capability_name: string;
  category_path: string[];
  description: string;
  parameters: WorkflowParameter[];
  confidence: number;
  reasoning: string;
}

export interface Proposal {
  id: string;
  pattern_id: string | null;
  proposal: LabelProposal;
  confidence: number;
  created_at: string;
  occurrence_count: number | null;
  domains: string[] | null;
  step_template: StepTemplate[] | null;
}

export interface StepTemplate {
  action: string;
  target?: Record<string, unknown>;
  value?: unknown;
  url?: string;
}

export interface Pattern {
  id: string;
  fingerprint: string;
  occurrence_count: number;
  domains: string[];
  step_template: StepTemplate[];
  last_seen_at: string;
  example_workflow_id: string | null;
  has_pending_proposal: boolean;
  has_approved_capability: boolean;
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

export interface RunCapabilityResult {
  capabilityId: string;
  success: boolean;
  checkpoints: CheckpointResult[];
  failedAt?: number;
  domSnapshot?: string;
  error?: string;
  repair?: RepairSuggestion;
}
