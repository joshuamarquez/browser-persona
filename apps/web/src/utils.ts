import type { StepTemplate } from './types';

export function formatCategory(path: string[]): string {
  return path.length > 0 ? path.join(' › ') : 'Uncategorized';
}

export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatSteps(steps: StepTemplate[] | null | undefined): string {
  if (!steps?.length) return 'No steps';
  return steps
    .map((s) => {
      const target =
        (s.target?.text as string | undefined) ??
        (s.target?.name as string | undefined) ??
        (s.url
          ? (() => {
              try {
                return new URL(s.url!).pathname;
              } catch {
                return s.url!;
              }
            })()
          : '');
      if (s.action === 'navigate') return `Navigate ${target || s.url || ''}`;
      if (s.action === 'click') return `Click ${target || 'element'}`;
      if (s.action === 'fill') return `Fill ${target || 'field'}`;
      return s.action;
    })
    .join(' → ');
}

export function parseCategoryInput(input: string): string[] {
  return input
    .split(/[>/,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
