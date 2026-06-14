import OpenAI from 'openai';
import { z } from 'zod';
import type { MergeJudgment } from '@browser-persona/pattern-miner';

const MergeJudgmentSchema = z.object({
  same_pattern: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export interface CompactWorkflowStep {
  action: string;
  target?: string;
  value?: unknown;
  url?: string;
}

export interface WorkflowForMerge {
  id: string;
  domain: string;
  steps: CompactWorkflowStep[];
}

const SYSTEM_PROMPT = `You decide whether two browser workflow recordings describe the same user intent.

Rules:
- same_pattern=true when both workflows accomplish the same goal, even if one has extra noise steps (icon clicks, scrolls) or a missing optional step
- same_pattern=false when goals differ (different search, different export, different page intent)
- Ignore tracking query params in URLs; focus on path and user actions
- "navigate" to the same site section with different query strings can still match
- Partial workflows (only the first half of a longer journey) are NOT the same pattern
- Return strict JSON: same_pattern (boolean), confidence (0-1), reasoning (short string)`;

function compactTarget(target: Record<string, unknown> | null | undefined): string | undefined {
  if (!target) return undefined;
  const text = target.text ?? target.ariaLabel ?? target.name ?? target.selector ?? target.tag;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

function shortenUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url.length > 80 ? `${url.slice(0, 80)}…` : url;
  }
}

export function compactWorkflowSteps(
  rows: Array<{ action: string; target: object; value: unknown; url: string | null }>,
): CompactWorkflowStep[] {
  return rows.map((row) => ({
    action: row.action,
    target: compactTarget(row.target as Record<string, unknown>),
    value: row.value,
    url: shortenUrl(row.url),
  }));
}

export async function judgeWorkflowMerge(
  workflowA: WorkflowForMerge,
  workflowB: WorkflowForMerge,
): Promise<MergeJudgment> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const userPayload = {
    workflow_a: {
      id: workflowA.id,
      domain: workflowA.domain,
      steps: workflowA.steps,
    },
    workflow_b: {
      id: workflowB.id,
      domain: workflowB.domain,
      steps: workflowB.steps,
    },
  };

  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Do these two workflows represent the same repeated user pattern?\n\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty LLM response');
  }

  const parsed = MergeJudgmentSchema.parse(JSON.parse(raw));
  return {
    samePattern: parsed.same_pattern,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}
