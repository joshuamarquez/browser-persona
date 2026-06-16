import {
  isIntentWorkflow,
  maxTaskRisk,
  type IntentWorkflow,
} from '@browser-persona/shared';
import { query } from './db.js';

export function getAutoApproveConfidenceThreshold(): number {
  const n = Number(process.env.INTENT_AUTO_APPROVE_CONFIDENCE ?? 0.85);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
}

export function getAutoApproveDomainBlocklist(): string[] {
  const raw = process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST ?? '';
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

export function isAutoApproveEligible(intent: IntentWorkflow): boolean {
  if (!intent.is_automatable) return false;
  if (intent.confidence < getAutoApproveConfidenceThreshold()) return false;
  if (maxTaskRisk(intent.tasks) === 'high') return false;

  const blocklist = getAutoApproveDomainBlocklist();
  const domain = normalizeDomain(intent.domain);
  return !blocklist.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

export async function createCapabilityFromIntent(
  userId: string,
  workflowId: string,
  intent: IntentWorkflow,
  options: {
    confidence: number;
    llmModel: string;
    promptVersion: string;
    name?: string;
    description?: string;
    categoryPath?: string[];
  },
): Promise<{ capabilityId: string }> {
  const referenceSteps = await query<{
    action: string;
    target: object;
    value: unknown;
    url: string | null;
  }>(
    `SELECT action, target, value, url FROM workflow_steps
     WHERE workflow_id = $1 ORDER BY step_index`,
    [workflowId],
  );

  const cap = await query<{ id: string }>(
    `INSERT INTO capabilities (
       user_id, status, name, description, category_path, parameters,
       step_template, tasks, source_workflow_id, risk_level,
       confidence, llm_model, llm_prompt_version, metadata, approved_at, approved_by
     )
     VALUES ($1, 'approved', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $1)
     RETURNING id`,
    [
      userId,
      options.name ?? intent.name,
      options.description ?? intent.description,
      options.categoryPath ?? intent.category_path,
      JSON.stringify(intent.parameters),
      JSON.stringify(referenceSteps),
      JSON.stringify(intent.tasks),
      workflowId,
      maxTaskRisk(intent.tasks),
      options.confidence,
      options.llmModel,
      options.promptVersion,
      JSON.stringify({ domain: intent.domain, plan_cache: {} }),
    ],
  );

  return { capabilityId: cap[0].id };
}

export interface ProposalRow {
  id: string;
  workflow_id: string;
  proposal: Record<string, unknown>;
  confidence: number;
  created_at: string;
  domains: string[] | null;
  step_template: unknown[] | null;
}

export interface ApproveEdits {
  name?: string;
  category_path?: string[];
  description?: string;
}

function proposalName(proposal: Record<string, unknown>): string {
  if (typeof proposal.name === 'string') return proposal.name;
  return 'Untitled';
}

function proposalCategoryPath(proposal: Record<string, unknown>): string[] {
  if (Array.isArray(proposal.category_path)) {
    return proposal.category_path.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function proposalDescription(proposal: Record<string, unknown>): string {
  return typeof proposal.description === 'string' ? proposal.description : '';
}

function proposalConfidence(proposal: Record<string, unknown>, fallback: number): number {
  return typeof proposal.confidence === 'number' ? proposal.confidence : fallback;
}

export async function listProposals(
  userId: string,
  reviewed = false,
): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT ip.id, ip.workflow_id, ip.proposal, ip.confidence, ip.created_at,
            ARRAY[w.primary_domain] AS domains,
            ref_steps.steps AS step_template
     FROM intent_proposals ip
     JOIN workflows w ON w.id = ip.workflow_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'action', ws.action,
             'target', ws.target,
             'value', ws.value,
             'url', ws.url
           ) ORDER BY ws.step_index
         ),
         '[]'::jsonb
       ) AS steps
       FROM workflow_steps ws
       WHERE ws.workflow_id = ip.workflow_id
     ) ref_steps ON true
     WHERE w.user_id = $1 AND ip.reviewed = $2
     ORDER BY ip.created_at DESC`,
    [userId, reviewed],
  );
}

export async function listIntentWorkflows(
  userId: string,
): Promise<
  Array<{
    id: string;
    primary_domain: string;
    status: string;
    created_at: string;
    has_pending_proposal: boolean;
    linked_capability_id: string | null;
  }>
> {
  return query(
    `SELECT w.id, w.primary_domain, w.status, w.created_at,
            EXISTS (
              SELECT 1 FROM intent_proposals ip
              WHERE ip.workflow_id = w.id AND ip.reviewed = false
            ) AS has_pending_proposal,
            (
              SELECT c.id FROM capabilities c
              WHERE c.user_id = $1
                AND c.status = 'approved'
                AND (
                  c.source_workflow_id = w.id
                  OR COALESCE(c.metadata->'linked_workflow_ids', '[]'::jsonb) @> jsonb_build_array(w.id::text)
                )
              LIMIT 1
            ) AS linked_capability_id
     FROM workflows w
     WHERE w.user_id = $1 AND w.status = 'intent_extracted'
     ORDER BY w.created_at DESC
     LIMIT 50`,
    [userId],
  );
}

export async function rejectProposal(proposalId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE intent_proposals ip
     SET reviewed = true, review_decision = 'reject', reviewed_at = now()
     FROM workflows w
     WHERE ip.id = $1
       AND ip.workflow_id = w.id
       AND w.user_id = $2
       AND ip.reviewed = false
     RETURNING ip.id`,
    [proposalId, userId],
  );
  return rows.length > 0;
}

export async function approveProposal(
  proposalId: string,
  userId: string,
  edits?: ApproveEdits,
): Promise<{ capabilityId: string }> {
  const proposals = await query<{
    id: string;
    workflow_id: string;
    proposal: Record<string, unknown>;
    confidence: number;
    llm_model: string;
    prompt_version: string;
  }>(`SELECT * FROM intent_proposals WHERE id = $1`, [proposalId]);

  if (proposals.length === 0) {
    throw new Error('Proposal not found');
  }

  const p = proposals[0];
  const owner = await query<{ id: string }>(
    `SELECT id FROM workflows WHERE id = $1 AND user_id = $2`,
    [p.workflow_id, userId],
  );
  if (owner.length === 0) {
    throw new Error('Proposal not found');
  }

  if (!isIntentWorkflow(p.proposal)) {
    throw new Error('Invalid intent proposal');
  }

  const intent = p.proposal as IntentWorkflow;
  const name = edits?.name ?? proposalName(p.proposal);
  const categoryPath = edits?.category_path ?? proposalCategoryPath(p.proposal);
  const description = edits?.description ?? proposalDescription(p.proposal);
  const confidence = proposalConfidence(p.proposal, Number(p.confidence));

  const { capabilityId } = await createCapabilityFromIntent(userId, p.workflow_id, intent, {
    confidence,
    llmModel: p.llm_model,
    promptVersion: p.prompt_version,
    name,
    description,
    categoryPath,
  });

  await query(
    `UPDATE intent_proposals SET reviewed = true, review_decision = 'approve', reviewed_at = now() WHERE id = $1`,
    [proposalId],
  );

  return { capabilityId };
}
