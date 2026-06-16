import type {
  Capability,
  CapabilityDetail,
  CapabilityRun,
  IntentWorkflowSummary,
  Proposal,
  ReplayEventsResponse,
  RunCapabilityResult,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      throw new Error(parsed.error ?? parsed.message ?? (body || res.statusText));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(body || res.statusText);
      }
      throw err;
    }
  }
  return res.json() as Promise<T>;
}

export function fetchProposals(): Promise<{ proposals: Proposal[] }> {
  return request('/proposals');
}

export function fetchIntentWorkflows(): Promise<{ workflows: IntentWorkflowSummary[] }> {
  return request('/workflows/intent');
}

export function fetchCapabilities(): Promise<{ capabilities: Capability[] }> {
  return request('/capabilities');
}

export function fetchCapabilityRuns(capabilityId?: string): Promise<{ runs: CapabilityRun[] }> {
  const query = capabilityId ? `?capabilityId=${encodeURIComponent(capabilityId)}` : '';
  return request(`/capabilities/runs${query}`);
}

export function fetchCapability(capabilityId: string): Promise<{ capability: CapabilityDetail }> {
  return request(`/capabilities/${capabilityId}`);
}

export async function downloadPlaywrightScript(
  capabilityId: string,
  capabilityName: string,
): Promise<void> {
  const slug =
    capabilityName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'capability';

  const res = await fetch(`${API_BASE}/capabilities/${capabilityId}/playwright`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }

  const script = await res.text();
  const blob = new Blob([script], { type: 'text/typescript' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${slug}.playwright.ts`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

export function runCapability(
  capabilityId: string,
  parameters?: Record<string, string | number | boolean>,
): Promise<RunCapabilityResult> {
  return request(`/capabilities/${capabilityId}/run`, {
    method: 'POST',
    body: JSON.stringify({ parameters, suggestRepair: true }),
  });
}

export function approveProposal(
  proposalId: string,
  edits?: { name?: string; description?: string; category_path?: string[] },
): Promise<{ capabilityId: string }> {
  return request('/capabilities/approve', {
    method: 'POST',
    body: JSON.stringify({ proposalId, edits }),
  });
}

export function rejectProposal(proposalId: string): Promise<{ rejected: boolean }> {
  return request(`/proposals/${proposalId}/reject`, { method: 'POST' });
}

export function runPipeline(): Promise<Record<string, unknown>> {
  return request('/pipeline/run', { method: 'POST' });
}

export function reprocessPipeline(): Promise<Record<string, unknown>> {
  return request('/pipeline/reprocess', { method: 'POST' });
}

export function fetchWorkflowReplayEvents(workflowId: string): Promise<ReplayEventsResponse> {
  return request(`/workflows/${workflowId}/replay-events`);
}
