import OpenAI from 'openai';
import { z } from 'zod';
import type { PlanTaskInput, PlanTaskOutput } from '@browser-persona/intent-executor';
import type { TemplateStep } from '@browser-persona/playwright-executor';

const StepTargetSchema = z.object({
  selector: z.string().optional(),
  text: z.string().optional(),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
});

const TemplateStepSchema = z.object({
  action: z.enum(['navigate', 'click', 'fill', 'select', 'scroll', 'submit', 'wait']),
  target: StepTargetSchema.optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  url: z.string().optional(),
});

export const PlanOutputSchema = z.object({
  actions: z.array(TemplateStepSchema).min(1),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `You plan browser automation steps to achieve a single task goal on the current page.

Rules:
- Output Playwright-compatible actions only: navigate, click, fill, select, scroll, submit, wait
- Prefer role+name or visible text targets over brittle CSS selectors
- Use wait actions sparingly (value = milliseconds)
- Do not invent URLs unless navigation is required
- Return strict JSON: actions (array), reasoning (string), confidence (0-1)

Example:
{
  "actions": [
    {"action": "click", "target": {"role": "link", "text": "Reports"}},
    {"action": "wait", "value": 500}
  ],
  "reasoning": "Open Reports from nav",
  "confidence": 0.9
}`;

export interface PlanTaskRequest extends PlanTaskInput {
  capabilityName: string;
}

export function parsePlanOutput(raw: string): PlanTaskOutput {
  const parsed = PlanOutputSchema.parse(JSON.parse(raw));
  return {
    actions: parsed.actions as TemplateStep[],
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
  };
}

export async function planTask(input: PlanTaskRequest): Promise<PlanTaskOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const userPayload = {
    capability_name: input.capabilityName,
    task: input.task,
    parameters: input.parameters,
    current_url: input.currentUrl,
    interactive_snapshot: input.interactiveSnapshot,
    previous_failure: input.previousFailure,
  };

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Plan actions to complete this task on the current page. Return JSON with actions, reasoning, confidence.\n\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty LLM response');
  }

  return parsePlanOutput(raw);
}
