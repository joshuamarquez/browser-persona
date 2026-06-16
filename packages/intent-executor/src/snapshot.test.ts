import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { buildInteractiveSnapshot } from './snapshot.ts';

test('buildInteractiveSnapshot caps output length', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const buttons = Array.from({ length: 200 }, (_, i) => `<button>Action ${i}</button>`).join('');
  await page.setContent(`<html><body>${buttons}</body></html>`);

  const snapshot = await buildInteractiveSnapshot(page, 500);
  assert.ok(snapshot.length <= 520);
  assert.ok(snapshot.includes('truncated'));

  await browser.close();
});

test('buildInteractiveSnapshot lists interactive elements', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(
    '<a href="/usage">Usage</a><input name="q" value="hello" /><button>Go</button>',
  );

  const snapshot = await buildInteractiveSnapshot(page, 5000);
  assert.match(snapshot, /Usage/);
  assert.match(snapshot, /Go/);
  assert.match(snapshot, /value="hello"/);

  await browser.close();
});
