import type { Page } from 'playwright';

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=textbox]';

export async function buildInteractiveSnapshot(
  page: Page,
  maxChars = 10_000,
): Promise<string> {
  const lines = await page.locator(INTERACTIVE_SELECTOR).evaluateAll((elements) => {
    return elements
      .filter((el) => {
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') ?? tag;
        const aria = el.getAttribute('aria-label');
        const name =
          aria ??
          (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
          el.getAttribute('name') ??
          el.getAttribute('placeholder') ??
          el.textContent?.trim()?.slice(0, 80) ??
          '';
        let value = '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          value = el.value;
        } else if (el instanceof HTMLSelectElement) {
          value = el.value;
        }
        const valuePart = value ? ` value="${value.slice(0, 120)}"` : '';
        return `[${role}] "${name.replace(/\s+/g, ' ').trim()}"${valuePart}`;
      });
  });

  let snapshot = lines.join('\n');
  if (snapshot.length > maxChars) {
    snapshot = `${snapshot.slice(0, maxChars)}\n… (truncated)`;
  }
  return snapshot;
}
