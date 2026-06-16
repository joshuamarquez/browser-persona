import OpenAI from 'openai';
import { z } from 'zod';
import type { IntentTask, IntentWorkflow } from '@browser-persona/shared';
import { query } from './db.js';

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';

export function getDedupSimilarityHigh(): number {
  const n = Number(process.env.INTENT_DEDUP_SIMILARITY_HIGH ?? 0.92);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.92;
}

export function getDedupSimilarityLow(): number {
  const n = Number(process.env.INTENT_DEDUP_SIMILARITY_LOW ?? 0.8);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.8;
}

export function isDedupConfirmEnabled(): boolean {
  if (process.env.INTENT_DEDUP_LLM_CONFIRM === 'false') return false;
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return new OpenAI({ apiKey });
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

export function buildIntentEmbeddingText(intent: IntentWorkflow): string {
  const goals = [...intent.tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => t.goal)
    .join(' | ');
  return `${normalizeDomain(intent.domain)}\n${intent.name.trim()}\n${goals}`;
}

export function buildCapabilityEmbeddingText(
  name: string,
  domain: string,
  tasks: IntentTask[],
): string {
  const goals = [...tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => t.goal)
    .join(' | ');
  return `${normalizeDomain(domain)}\n${name.trim()}\n${goals}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function embedText(text: string): Promise<number[]> {
  const client = getOpenAI();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vector = response.data[0]?.embedding;
  if (!vector?.length) {
    throw new Error('Embedding API returned empty vector');
  }
  return vector;
}

export interface ExistingIntentCapability {
  id: string;
  name: string;
  domain: string;
  tasks: IntentTask[];
}

export interface DedupMatch {
  capabilityId: string;
  similarity: number;
  confirmed: boolean;
}

export interface DedupResult {
  matched: boolean;
  match?: DedupMatch;
}

const DedupConfirmSchema = z.object({
  same_intent: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export async function confirmSameIntent(
  newIntent: IntentWorkflow,
  existing: ExistingIntentCapability,
): Promise<{ same: boolean; confidence: number }> {
  const client = getOpenAI();
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const formatIntent = (name: string, domain: string, tasks: IntentTask[]) => ({
    name,
    domain,
    tasks: tasks.map((t) => ({ goal: t.goal, risk: t.risk })),
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You decide whether two browser automation intents describe the same user journey.
Return JSON: same_intent (boolean), confidence (0-1), reasoning (string).
Same intent means the user would run one capability instead of maintaining two.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          new_intent: formatIntent(newIntent.name, newIntent.domain, newIntent.tasks),
          existing_intent: formatIntent(existing.name, existing.domain, existing.tasks),
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    return { same: false, confidence: 0 };
  }

  const parsed = DedupConfirmSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { same: false, confidence: 0 };
  }

  return {
    same: parsed.data.same_intent && parsed.data.confidence >= 0.7,
    confidence: parsed.data.confidence,
  };
}

async function loadExistingIntentCapabilities(userId: string): Promise<ExistingIntentCapability[]> {
  const rows = await query<{
    id: string;
    name: string;
    tasks: IntentTask[];
    metadata: { domain?: string; linked_workflow_ids?: string[] } | null;
    primary_domain: string | null;
  }>(
    `SELECT c.id, c.name, c.tasks, c.metadata,
            w.primary_domain
     FROM capabilities c
     LEFT JOIN workflows w ON w.id = c.source_workflow_id
     WHERE c.user_id = $1
       AND c.status = 'approved'
       AND jsonb_array_length(c.tasks) > 0`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    domain:
      (typeof row.metadata?.domain === 'string' && row.metadata.domain) ||
      row.primary_domain ||
      'unknown',
  }));
}

export async function findIntentDedupMatch(
  userId: string,
  intent: IntentWorkflow,
): Promise<DedupResult> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return { matched: false };
  }

  const existing = await loadExistingIntentCapabilities(userId);
  if (existing.length === 0) {
    return { matched: false };
  }

  const intentDomain = normalizeDomain(intent.domain);
  const candidates = existing.filter((cap) => normalizeDomain(cap.domain) === intentDomain);
  if (candidates.length === 0) {
    return { matched: false };
  }

  const intentVector = await embedText(buildIntentEmbeddingText(intent));
  const high = getDedupSimilarityHigh();
  const low = getDedupSimilarityLow();

  let best: { cap: ExistingIntentCapability; similarity: number } | undefined;

  for (const cap of candidates) {
    const similarity = cosineSimilarity(
      intentVector,
      await embedText(buildCapabilityEmbeddingText(cap.name, cap.domain, cap.tasks)),
    );
    if (!best || similarity > best.similarity) {
      best = { cap, similarity };
    }
  }

  if (!best) {
    return { matched: false };
  }

  if (best.similarity >= high) {
    return {
      matched: true,
      match: {
        capabilityId: best.cap.id,
        similarity: best.similarity,
        confirmed: true,
      },
    };
  }

  if (best.similarity >= low && isDedupConfirmEnabled()) {
    const confirm = await confirmSameIntent(intent, best.cap);
    if (confirm.same) {
      return {
        matched: true,
        match: {
          capabilityId: best.cap.id,
          similarity: best.similarity,
          confirmed: true,
        },
      };
    }
  }

  return { matched: false };
}

export async function linkWorkflowToCapability(
  workflowId: string,
  capabilityId: string,
): Promise<void> {
  const rows = await query<{ metadata: { linked_workflow_ids?: string[] } | null }>(
    `SELECT metadata FROM capabilities WHERE id = $1`,
    [capabilityId],
  );
  const metadata = rows[0]?.metadata ?? {};
  const linked = Array.isArray(metadata.linked_workflow_ids) ? metadata.linked_workflow_ids : [];
  if (!linked.includes(workflowId)) {
    linked.push(workflowId);
  }

  await query(
    `UPDATE capabilities
     SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{linked_workflow_ids}', $2::jsonb)
     WHERE id = $1`,
    [capabilityId, JSON.stringify(linked)],
  );

  await query(`UPDATE workflows SET status = 'intent_extracted' WHERE id = $1`, [workflowId]);
}
