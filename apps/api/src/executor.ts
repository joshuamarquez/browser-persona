import { query } from './db.js';
import type { WorkflowParameter } from '@browser-persona/shared';
import type { TemplateStep } from '@browser-persona/playwright-executor';

export interface CapabilityRecord {
  id: string;
  name: string;
  description: string | null;
  status: string;
  parameters: WorkflowParameter[];
  step_template: TemplateStep[];
}

export async function getCapability(
  capabilityId: string,
  userId: string,
): Promise<CapabilityRecord | null> {
  const rows = await query<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    parameters: WorkflowParameter[];
    step_template: TemplateStep[];
  }>(
    `SELECT id, name, description, status, parameters, step_template
     FROM capabilities WHERE id = $1 AND user_id = $2`,
    [capabilityId, userId],
  );

  if (rows.length === 0) return null;
  return rows[0];
}
