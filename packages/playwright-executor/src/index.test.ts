import assert from 'node:assert/strict';
import test from 'node:test';
import { exportPlaywrightScript } from './export.ts';
import { checkpointExpression } from './steps.ts';
import { resolveLocatorSpec } from './locator.ts';

test('resolveLocatorSpec prefers selector then role then label', () => {
  assert.deepEqual(resolveLocatorSpec({ selector: '#x' }), { kind: 'selector', selector: '#x' });
  assert.deepEqual(resolveLocatorSpec({ role: 'button', text: 'Save' }), {
    kind: 'role',
    role: 'button',
    name: 'Save',
  });
  assert.deepEqual(resolveLocatorSpec({ name: 'start_date' }), { kind: 'name', name: 'start_date' });
});

test('checkpointExpression emits navigate and fill validation', () => {
  const navigate = checkpointExpression(0, {
    action: 'navigate',
    url: 'https://crm.example.com/reports',
  });
  assert.ok(navigate.some((line) => line.includes('page.goto')));
  assert.ok(navigate.some((line) => line.includes('URL checkpoint failed')));

  const fill = checkpointExpression(1, {
    action: 'fill',
    target: { name: 'start_date' },
    value: '2026-06-01',
  });
  assert.ok(fill.some((line) => line.includes('.fill(')));
  assert.ok(fill.some((line) => line.includes('Fill checkpoint failed')));
});

test('exportPlaywrightScript includes capability metadata and params', () => {
  const script = exportPlaywrightScript({
    capabilityId: 'cap-1',
    capabilityName: 'Export weekly sales report',
    description: 'Opens report and exports CSV',
    parameters: [{ name: 'start_date', type: 'date', example: '2026-06-01' }],
    stepTemplate: [
      { action: 'navigate', url: 'https://crm.example.com/reports' },
      { action: 'click', target: { text: 'Weekly Sales' } },
    ],
  });

  assert.match(script, /Export weekly sales report/);
  assert.match(script, /chromium\.launch\(\{ headless: false/);
  assert.match(script, /START_DATE/);
  assert.match(script, /Weekly Sales/);
});
