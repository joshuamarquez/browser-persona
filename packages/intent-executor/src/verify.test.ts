import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { verifyTask } from './verify.ts';

test('verifyTask url_contains matches pathname', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('https://example.com/usage/settings', async (route) => {
    await route.fulfill({ body: '<html><body>ok</body></html>', contentType: 'text/html' });
  });
  await page.goto('https://example.com/usage/settings');

  const result = await verifyTask(
    {
      kind: 'url_contains',
      description: 'On usage page',
      spec: { urlPattern: '/usage' },
    },
    { page, parameters: {}, timeoutMs: 3000 },
  );

  assert.equal(result.passed, true);
  await browser.close();
});

test('verifyTask element_visible finds button text', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<button>Export CSV</button>');

  const result = await verifyTask(
    {
      kind: 'element_visible',
      description: 'Export visible',
      spec: { text: 'Export CSV' },
    },
    { page, parameters: {}, timeoutMs: 3000 },
  );

  assert.equal(result.passed, true);
  await browser.close();
});

test('verifyTask element_state checks input value with interpolation', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<input name="start" value="2026-06-01" />');

  const result = await verifyTask(
    {
      kind: 'element_state',
      description: 'Start date set',
      spec: { selector: 'input[name="start"]', value: '{{start_date}}' },
    },
    { page, parameters: { start_date: '2026-06-01' }, timeoutMs: 3000 },
  );

  assert.equal(result.passed, true, result.message);
  await browser.close();
});

test('verifyTask url_matches uses regex pattern', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('https://example.com/usage', async (route) => {
    await route.fulfill({ body: '<html><body>ok</body></html>', contentType: 'text/html' });
  });
  await page.goto('https://example.com/usage');

  const result = await verifyTask(
    {
      kind: 'url_matches',
      description: 'Usage path',
      spec: { urlPattern: 'example\\.com/usage' },
    },
    { page, parameters: {}, timeoutMs: 3000 },
  );

  assert.equal(result.passed, true);
  await browser.close();
});
