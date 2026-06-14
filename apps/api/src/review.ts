import { query } from './db.js';

export interface ProposalRow {
  id: string;
  pattern_id: string | null;
  proposal: {
    capability_name: string;
    category_path: string[];
    description: string;
    parameters: unknown[];
    confidence: number;
    reasoning: string;
  };
  confidence: number;
  created_at: string;
  occurrence_count: number | null;
  domains: string[] | null;
  step_template: unknown[] | null;
}

export interface PatternRow {
  id: string;
  fingerprint: string;
  occurrence_count: number;
  domains: string[];
  step_template: unknown[];
  last_seen_at: string;
  example_workflow_id: string | null;
  has_pending_proposal: boolean;
  has_approved_capability: boolean;
}

export async function listProposals(
  userId: string,
  reviewed = false,
): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT lp.id, lp.pattern_id, lp.proposal, lp.confidence, lp.created_at,
            wp.occurrence_count, wp.domains, wp.step_template
     FROM labeling_proposals lp
     JOIN workflow_patterns wp ON wp.id = lp.pattern_id
     WHERE wp.user_id = $1 AND lp.reviewed = $2
     ORDER BY lp.created_at DESC`,
    [userId, reviewed],
  );
}

export async function listPatterns(userId: string): Promise<PatternRow[]> {
  return query<PatternRow>(
    `SELECT wp.id, wp.fingerprint, wp.occurrence_count, wp.domains,
            wp.step_template, wp.last_seen_at, wp.example_workflow_id,
            EXISTS (
              SELECT 1 FROM labeling_proposals lp
              WHERE lp.pattern_id = wp.id AND lp.reviewed = false
            ) AS has_pending_proposal,
            EXISTS (
              SELECT 1 FROM capabilities c
              WHERE c.pattern_id = wp.id AND c.status = 'approved'
            ) AS has_approved_capability
     FROM workflow_patterns wp
     WHERE wp.user_id = $1
     ORDER BY wp.occurrence_count DESC, wp.last_seen_at DESC`,
    [userId],
  );
}

export async function rejectProposal(proposalId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE labeling_proposals lp
     SET reviewed = true, review_decision = 'reject', reviewed_at = now()
     FROM workflow_patterns wp
     WHERE lp.id = $1 AND lp.pattern_id = wp.id AND wp.user_id = $2 AND lp.reviewed = false
     RETURNING lp.id`,
    [proposalId, userId],
  );
  return rows.length > 0;
}
