import type { Page, Locator } from 'playwright';
import type { StepTarget } from '@browser-persona/shared';
import { locatorExpression, resolveLocatorSpec } from './locator.js';

export interface TemplateStep {
  action: string;
  target?: StepTarget;
  value?: unknown;
  url?: string;
}

export interface CheckpointResult {
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed';
  message: string;
  durationMs: number;
}

export interface StepExecutionContext {
  page: Page;
  parameters: Record<string, string | number | boolean>;
  timeoutMs: number;
}

function resolveStepValue(
  step: TemplateStep,
  parameters: Record<string, string | number | boolean>,
): string | number | boolean | null | undefined {
  const fieldName = step.target?.name ?? step.target?.ariaLabel;
  if (fieldName && fieldName in parameters) {
    return parameters[fieldName];
  }
  return step.value as string | number | boolean | null | undefined;
}

async function resolveLocator(page: Page, target: StepTarget | undefined): Promise<Locator | null> {
  const spec = resolveLocatorSpec(target);
  if (!spec) return null;

  switch (spec.kind) {
    case 'selector':
      return page.locator(spec.selector ?? '');
    case 'role':
      return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], {
        name: spec.name,
      });
    case 'label':
      return page.getByLabel(spec.name ?? '');
    case 'name':
      return page.locator(`[name="${spec.name?.replace(/"/g, '\\"') ?? ''}"]`);
    case 'text':
      return page.getByText(spec.name ?? '', { exact: spec.exact ?? true });
    default:
      return null;
  }
}

function urlCheckpointPattern(url: string): RegExp {
  try {
    const parsed = new URL(url);
    return new RegExp(escapeRegex(parsed.pathname + parsed.search));
  } catch {
    return new RegExp(escapeRegex(url));
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function executeStepWithCheckpoint(
  stepIndex: number,
  step: TemplateStep,
  ctx: StepExecutionContext,
): Promise<CheckpointResult> {
  const started = Date.now();
  const action = step.action;

  try {
    switch (action) {
      case 'navigate': {
        const url = step.url;
        if (!url) throw new Error('Navigate step missing url');
        await ctx.page.goto(url, { timeout: ctx.timeoutMs, waitUntil: 'domcontentloaded' });
        await ctx.page.waitForLoadState('networkidle', { timeout: ctx.timeoutMs }).catch(() => {});
        const current = ctx.page.url();
        const pattern = urlCheckpointPattern(url);
        if (!pattern.test(current)) {
          throw new Error(`URL checkpoint failed: expected ${url}, got ${current}`);
        }
        return passed(stepIndex, action, `Loaded ${current}`, started);
      }

      case 'click':
      case 'submit': {
        const locator = await resolveLocator(ctx.page, step.target);
        if (!locator) throw new Error(`${action} step missing resolvable target`);
        await locator.first().click({ timeout: ctx.timeoutMs });
        await ctx.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        return passed(stepIndex, action, `Clicked ${describeTarget(step.target)}`, started);
      }

      case 'fill': {
        const locator = await resolveLocator(ctx.page, step.target);
        if (!locator) throw new Error('Fill step missing resolvable target');
        const value = resolveStepValue(step, ctx.parameters);
        if (value == null || value === '') throw new Error('Fill step missing value');
        const text = String(value);
        await locator.first().fill(text, { timeout: ctx.timeoutMs });
        const actual = await locator.first().inputValue().catch(() => text);
        if (actual !== text) {
          throw new Error(`Fill checkpoint failed: expected "${text}", got "${actual}"`);
        }
        return passed(stepIndex, action, `Filled ${describeTarget(step.target)}`, started);
      }

      case 'select': {
        const locator = await resolveLocator(ctx.page, step.target);
        if (!locator) throw new Error('Select step missing resolvable target');
        const value = resolveStepValue(step, ctx.parameters);
        if (typeof value === 'boolean') {
          if (value) await locator.first().check({ timeout: ctx.timeoutMs });
          else await locator.first().uncheck({ timeout: ctx.timeoutMs });
        } else if (value != null) {
          await locator.first().selectOption(String(value), { timeout: ctx.timeoutMs });
        } else {
          throw new Error('Select step missing value');
        }
        return passed(stepIndex, action, `Selected ${describeTarget(step.target)}`, started);
      }

      case 'scroll': {
        const locator = await resolveLocator(ctx.page, step.target);
        if (locator) {
          await locator.first().scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs });
        } else {
          const y = typeof step.value === 'number' ? step.value : 0;
          await ctx.page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
        }
        return passed(stepIndex, action, 'Scroll checkpoint passed', started);
      }

      case 'wait': {
        const ms = typeof step.value === 'number' ? step.value : 1000;
        await ctx.page.waitForTimeout(ms);
        return passed(stepIndex, action, `Waited ${ms}ms`, started);
      }

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stepIndex,
      action,
      status: 'failed',
      message,
      durationMs: Date.now() - started,
    };
  }
}

function passed(stepIndex: number, action: string, message: string, started: number): CheckpointResult {
  return {
    stepIndex,
    action,
    status: 'passed',
    message,
    durationMs: Date.now() - started,
  };
}

function describeTarget(target: StepTarget | undefined): string {
  if (!target) return 'target';
  return target.text ?? target.name ?? target.ariaLabel ?? target.selector ?? target.role ?? 'target';
}

export function checkpointExpression(stepIndex: number, step: TemplateStep): string[] {
  const lines: string[] = [];
  const comment = `// Step ${stepIndex + 1}: ${step.action}`;

  switch (step.action) {
    case 'navigate': {
      const url = step.url ?? '';
      lines.push(comment);
      lines.push(`await page.goto(${JSON.stringify(url)});`);
      lines.push(
        `if (!${urlPatternLiteral(url)}.test(page.url())) throw new Error(\`URL checkpoint failed: expected ${url}, got \${page.url()}\`);`,
      );
      break;
    }
    case 'click':
    case 'submit': {
      const spec = resolveLocatorSpec(step.target);
      if (!spec) break;
      const locator = locatorExpression(spec);
      lines.push(comment);
      lines.push(`await ${locator}.first().click();`);
      lines.push(`await page.waitForLoadState('domcontentloaded').catch(() => {});`);
      break;
    }
    case 'fill': {
      const spec = resolveLocatorSpec(step.target);
      if (!spec) break;
      const locator = locatorExpression(spec);
      const fieldName = step.target?.name ?? step.target?.ariaLabel;
      const valueExpr =
        fieldName != null
          ? `(params[${JSON.stringify(fieldName)}] ?? ${JSON.stringify(step.value ?? '')})`
          : JSON.stringify(step.value ?? '');
      lines.push(comment);
      lines.push(`await ${locator}.first().fill(String(${valueExpr}));`);
      lines.push(
        `if (await ${locator}.first().inputValue() !== String(${valueExpr})) throw new Error('Fill checkpoint failed');`,
      );
      break;
    }
    case 'select': {
      const spec = resolveLocatorSpec(step.target);
      if (!spec) break;
      const locator = locatorExpression(spec);
      const fieldName = step.target?.name ?? step.target?.ariaLabel;
      const valueExpr =
        fieldName != null
          ? `(params[${JSON.stringify(fieldName)}] ?? ${JSON.stringify(step.value ?? '')})`
          : JSON.stringify(step.value ?? '');
      lines.push(comment);
      if (typeof step.value === 'boolean') {
        lines.push(
          `if (${valueExpr}) await ${locator}.first().check(); else await ${locator}.first().uncheck();`,
        );
      } else {
        lines.push(`await ${locator}.first().selectOption(String(${valueExpr}));`);
      }
      break;
    }
    case 'scroll': {
      const spec = resolveLocatorSpec(step.target);
      lines.push(comment);
      if (spec) {
        lines.push(`await ${locatorExpression(spec)}.first().scrollIntoViewIfNeeded();`);
      } else {
        lines.push(`await page.evaluate((y) => window.scrollTo(0, y), ${Number(step.value ?? 0)});`);
      }
      break;
    }
    case 'wait': {
      lines.push(comment);
      lines.push(`await page.waitForTimeout(${Number(step.value ?? 1000)});`);
      break;
    }
    default:
      lines.push(`${comment} (skipped — unsupported action "${step.action}")`);
  }

  return lines;
}

function urlPatternLiteral(url: string): string {
  try {
    const parsed = new URL(url);
    const fragment = parsed.pathname + parsed.search;
    return `/${escapeRegex(fragment)}/`;
  } catch {
    return `/${escapeRegex(url)}/`;
  }
}
