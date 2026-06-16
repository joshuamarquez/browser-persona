import { query } from './db.js';

export interface AutomationOffer {
  type: 'proposal' | 'capability';
  workflowId: string;
  capabilityId?: string;
  name: string;
  description: string;
  confidence: number;
  taskCount: number;
}

/** Offers for a session after intent extraction (extension notification). */
export async function getAutomationOffersForSession(
  sessionId: string,
  userId: string,
): Promise<AutomationOffer[]> {
  const workflows = await query<{ id: string }>(
    `SELECT id FROM workflows WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (workflows.length === 0) return [];

  const workflowIds = workflows.map((w) => w.id);
  const offers: AutomationOffer[] = [];

  const proposals = await query<{
    workflow_id: string;
    proposal: Record<string, unknown>;
    confidence: number;
  }>(
    `SELECT ip.workflow_id, ip.proposal, ip.confidence
     FROM intent_proposals ip
     JOIN workflows w ON w.id = ip.workflow_id
     WHERE w.user_id = $1
       AND ip.workflow_id = ANY($2::uuid[])
       AND ip.reviewed = false`,
    [userId, workflowIds],
  );

  for (const p of proposals) {
    const tasks = Array.isArray(p.proposal.tasks) ? p.proposal.tasks : [];
    offers.push({
      type: 'proposal',
      workflowId: p.workflow_id,
      name: typeof p.proposal.name === 'string' ? p.proposal.name : 'New workflow',
      description: typeof p.proposal.description === 'string' ? p.proposal.description : '',
      confidence: Number(p.confidence),
      taskCount: tasks.length,
    });
  }

  const capabilities = await query<{
    id: string;
    source_workflow_id: string | null;
    name: string;
    description: string | null;
    confidence: number | null;
    tasks: unknown[];
  }>(
    `SELECT id, source_workflow_id, name, description, confidence, tasks
     FROM capabilities
     WHERE user_id = $1
       AND status = 'approved'
       AND source_workflow_id = ANY($2::uuid[])`,
    [userId, workflowIds],
  );

  for (const c of capabilities) {
    if (!c.source_workflow_id) continue;
    offers.push({
      type: 'capability',
      workflowId: c.source_workflow_id,
      capabilityId: c.id,
      name: c.name,
      description: c.description ?? '',
      confidence: Number(c.confidence ?? 1),
      taskCount: Array.isArray(c.tasks) ? c.tasks.length : 0,
    });
  }

  return offers;
}
