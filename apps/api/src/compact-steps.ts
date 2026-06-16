export interface CompactWorkflowStep {
  action: string;
  target?: string;
  value?: unknown;
  url?: string;
}

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
