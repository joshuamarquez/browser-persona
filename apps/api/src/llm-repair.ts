import OpenAI from 'openai';
import { z } from 'zod';
import type { TemplateStep } from '@browser-persona/playwright-executor';

const RepairSchema = z.object({
  diagnosis: z.string(),
  suggested_step_patch: z
    .object({
      target: z
        .object({
          selector: z.string().optional(),
          text: z.string().optional(),
          role: z.string().optional(),
          ariaLabel: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      wait_ms: z.number().optional(),
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type RepairSuggestion = z.infer<typeof RepairSchema>;

export interface SuggestRepairInput {
  capabilityName: string;
  failedStepIndex: number;
  failedStep: TemplateStep;
  errorMessage: string;
  domSnapshot: string;
}

const SYSTEM_PROMPT = `You help repair browser automation workflows when a Playwright step fails.

Given a failed semantic step, error message, and DOM snapshot, suggest a minimal patch.
Focus on updating target selectors/text/roles or adding a short wait — do not rewrite the whole workflow.
Return strict JSON with keys: diagnosis, suggested_step_patch (optional object), confidence (0-1), reasoning.`;

export async function suggestRepair(input: SuggestRepairInput): Promise<RepairSuggestion> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const userPayload = {
    capability_name: input.capabilityName,
    failed_step_index: input.failedStepIndex,
    failed_step: input.failedStep,
    error_message: input.errorMessage,
    dom_snapshot: input.domSnapshot.slice(0, 12_000),
  };

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Suggest a repair for this failed Playwright checkpoint.\n\n${JSON.stringify(userPayload, null, 2)}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty LLM response');
  }

  return RepairSchema.parse(JSON.parse(raw));
}
