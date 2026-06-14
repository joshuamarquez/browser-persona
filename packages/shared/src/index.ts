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

/** Strict LLM output schema */
export interface CapabilityLabelProposal {
  capability_name: string;
  category_path: string[];
  description: string;
  parameters: WorkflowParameter[];
  merge_with_pattern_ids: string[];
  confidence: number;
  reasoning: string;
}
