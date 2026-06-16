import type { Download, Page } from 'playwright';
import type { TaskVerification } from '@browser-persona/shared';
import { resolveLocatorSpec } from '@browser-persona/playwright-executor';
import { interpolateParams, interpolateParamsInValue } from './interpolate.js';

export interface VerifyContext {
  page: Page;
  parameters: Record<string, string | number | boolean>;
  timeoutMs: number;
  pendingDownload?: Promise<Download | null>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveLocator(page: Page, spec: TaskVerification['spec']) {
  if (!spec) return null;

  if (spec.selector) {
    return page.locator(spec.selector);
  }

  const target = {
    text: spec.text,
    role: spec.role,
    name: spec.name,
    ariaLabel: spec.name,
  };

  const resolved = resolveLocatorSpec(target);
  if (!resolved) {
    if (spec.text) {
      return page.getByText(spec.text, { exact: false });
    }
    return null;
  }

  switch (resolved.kind) {
    case 'selector':
      return page.locator(resolved.selector ?? '');
    case 'role':
      return page.getByRole(resolved.role as Parameters<Page['getByRole']>[0], {
        name: resolved.name,
      });
    case 'label':
      return page.getByLabel(resolved.name ?? '');
    case 'name':
      return page.locator(`[name="${resolved.name?.replace(/"/g, '\\"') ?? ''}"]`);
    case 'text':
      return page.getByText(resolved.name ?? '', { exact: resolved.exact ?? false });
    default:
      return null;
  }
}

export async function verifyTask(
  verification: TaskVerification,
  ctx: VerifyContext,
): Promise<{ passed: boolean; message: string }> {
  const { page, parameters, timeoutMs, pendingDownload } = ctx;

  switch (verification.kind) {
    case 'url_matches': {
      const pattern = interpolateParams(verification.spec?.urlPattern ?? '', parameters);
      if (!pattern) {
        return { passed: false, message: 'url_matches missing urlPattern' };
      }
      const current = page.url();
      const regex = new RegExp(pattern);
      if (!regex.test(current)) {
        return { passed: false, message: `URL does not match /${pattern}/ (got ${current})` };
      }
      return { passed: true, message: `URL matches ${pattern}` };
    }

    case 'url_contains': {
      const fragment = interpolateParams(verification.spec?.urlPattern ?? '', parameters);
      if (!fragment) {
        return { passed: false, message: 'url_contains missing urlPattern' };
      }
      const current = page.url();
      let haystack = current;
      try {
        const parsed = new URL(current);
        haystack = parsed.pathname + parsed.search + parsed.hash;
      } catch {
        /* use full url */
      }
      if (!haystack.includes(fragment) && !current.includes(fragment)) {
        return { passed: false, message: `URL does not contain "${fragment}" (got ${current})` };
      }
      return { passed: true, message: `URL contains ${fragment}` };
    }

    case 'element_visible': {
      const locator = await resolveLocator(page, verification.spec);
      if (!locator) {
        return { passed: false, message: 'element_visible missing resolvable target' };
      }
      const visible = await locator
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) {
        return { passed: false, message: `Element not visible: ${verification.description}` };
      }
      return { passed: true, message: verification.description || 'Element visible' };
    }

    case 'element_state': {
      const locator = await resolveLocator(page, verification.spec);
      if (!locator) {
        return { passed: false, message: 'element_state missing resolvable target' };
      }
      const expected = interpolateParamsInValue(verification.spec?.value, parameters);
      try {
        if (typeof expected === 'boolean') {
          const checked = await locator.first().isChecked({ timeout: timeoutMs });
          if (checked !== expected) {
            return { passed: false, message: `Expected checked=${expected}, got ${checked}` };
          }
          return { passed: true, message: 'Checkbox state matches' };
        }
        const actual = await locator.first().evaluate((el) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            return el.value;
          }
          if (el instanceof HTMLSelectElement) {
            return el.value;
          }
          return (el.textContent ?? '').trim();
        });
        const expectedStr = expected != null ? String(expected) : '';
        if (actual !== expectedStr) {
          return { passed: false, message: `Expected value "${expectedStr}", got "${actual}"` };
        }
        return { passed: true, message: 'Element state matches' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { passed: false, message: `element_state check failed: ${message}` };
      }
    }

    case 'download_started': {
      if (pendingDownload) {
        const download = await pendingDownload;
        if (download) {
          return { passed: true, message: `Download started: ${download.suggestedFilename()}` };
        }
        return { passed: false, message: 'No download event received' };
      }
      try {
        const download = await page.waitForEvent('download', { timeout: 2000 });
        void download.cancel().catch(() => {});
        return { passed: true, message: `Download started: ${download.suggestedFilename()}` };
      } catch {
        return { passed: false, message: 'No download detected' };
      }
    }

    case 'network_idle': {
      try {
        await page.waitForLoadState('networkidle', { timeout: timeoutMs });
        return { passed: true, message: 'Network idle' };
      } catch {
        return { passed: false, message: 'Network did not reach idle state' };
      }
    }

    case 'custom_assert':
      return { passed: false, message: 'custom_assert verification is not supported yet' };

    default:
      return { passed: false, message: `Unknown verification kind: ${verification.kind}` };
  }
}
