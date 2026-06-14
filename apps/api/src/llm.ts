import OpenAI from 'openai';
import { z } from 'zod';
import type { CapabilityLabelProposal } from '@browser-persona/shared';

const ParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'date', 'number', 'enum', 'boolean']),
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
  example: z.string().optional(),
});

/** LLMs sometimes return parameters as a keyed object instead of an array. */
function normalizeParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value;
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

const ProposalSchema = z.object({
  capability_name: z.string(),
  category_path: z.array(z.string()).min(1),
  description: z.string(),
  parameters: z.preprocess(normalizeParameters, z.array(ParameterSchema)),
  merge_with_pattern_ids: z.preprocess(
    (value) => (Array.isArray(value) ? value : []),
    z.array(z.string()),
  ),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const PROMPT_VERSION = process.env.LLM_PROMPT_VERSION ?? 'v1';

const SYSTEM_PROMPT = `You classify repetitive browser workflows into human-readable capabilities for a "virtual person" automation library.

Rules:
- Name capabilities by intent, not UI mechanics (good: "Export weekly sales report", bad: "Click button 3")
- category_path is 1-3 levels, broad to specific (e.g. ["Reporting", "Sales"])
- Extract parameters only when values change between occurrences (dates, names, IDs)
- merge_with_pattern_ids: leave empty unless clearly told similar pattern IDs exist
- confidence: 0-1 based on clarity of intent from steps alone
- Never include passwords or secrets in parameters
- parameters MUST be a JSON array of objects, each with name and type — use [] when none
- Return strict JSON matching the schema

Example shape:
{
  "capability_name": "Export weekly sales report",
  "category_path": ["Reporting", "Sales"],
  "description": "...",
  "parameters": [
    {"name": "start_date", "type": "date", "example": "2026-06-01"}
  ],
  "merge_with_pattern_ids": [],
  "confidence": 0.91,
  "reasoning": "..."
}`;

export interface LabelPatternInput {
  patternId: string;
  fingerprint: string;
  occurrenceCount: number;
  domains: string[];
  stepTemplate: unknown[];
  sampleValues?: Record<string, string>;
}

export async function labelPattern(input: LabelPatternInput): Promise<CapabilityLabelProposal> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const userPayload = {
    pattern_id: input.patternId,
    fingerprint: input.fingerprint,
    occurrence_count: input.occurrenceCount,
    domains: input.domains,
    step_template: input.stepTemplate,
    sample_parameter_values: input.sampleValues ?? {},
  };

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Analyze this workflow pattern and return JSON with keys: capability_name, category_path, description, parameters (array), merge_with_pattern_ids (array), confidence, reasoning.\n\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty LLM response');
  }

  const parsed = ProposalSchema.parse(JSON.parse(raw));
  return parsed;
}

export function getModelName(): string {
  return process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
}
