import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentTask } from '@browser-persona/shared';
import { runIntentCapability, type PlanTaskFn } from './run.ts';

const usageHtml = `<!DOCTYPE html><html><body>
  <a href="#" id="usage-link">Usage</a>
  <script>
    document.getElementById('usage-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = 'usage';
    });
  </script>
</body></html>`;

const navigateTask: IntentTask = {
  id: 't1',
  order: 1,
  goal: 'Open usage page',
  reference_hint: { action: 'click', target: { text: 'Usage' } },
  verification: {
    kind: 'url_contains',
    description: 'URL includes usage',
    spec: { urlPattern: 'usage' },
  },
  risk: 'low',
};

test('runIntentCapability passes with reference hint on fixture', async () => {
  const planTask: PlanTaskFn = async () => {
    throw new Error('Planner should not be called');
  };

  const result = await runIntentCapability({
    tasks: [navigateTask],
    headless: true,
    timeoutMs: 10_000,
    startUrl: `data:text/html,${encodeURIComponent(usageHtml)}`,
    planTask,
  });

  assert.equal(result.success, true, result.error ?? result.taskResults[0]?.message);
  assert.equal(result.taskResults[0]?.status, 'passed');
  assert.equal(result.taskResults[0]?.plannerUsed, false);
});

test('runIntentCapability replans when hint label changes', async () => {
  const exportTask: IntentTask = {
    id: 't2',
    order: 1,
    goal: 'Export CSV',
    reference_hint: { action: 'click', target: { text: 'Export CSV' } },
    verification: {
      kind: 'element_visible',
      description: 'Export complete message visible',
      spec: { text: 'Export complete' },
    },
    risk: 'low',
  };

  let planCalls = 0;
  const planTask: PlanTaskFn = async () => {
    planCalls += 1;
    return {
      actions: [{ action: 'click', target: { text: 'Download CSV' } }],
      reasoning: 'Label renamed',
      confidence: 0.95,
    };
  };

  const html = `<!DOCTYPE html><html><body>
    <button type="button" onclick="document.getElementById('status').hidden=false">Download CSV</button>
    <p id="status" hidden>Export complete</p>
  </body></html>`;

  const result = await runIntentCapability({
    tasks: [exportTask],
    headless: true,
    timeoutMs: 3_000,
    maxPlanCallsPerTask: 2,
    startUrl: `data:text/html,${encodeURIComponent(html)}`,
    planTask,
  });

  assert.equal(result.success, true, result.error ?? result.taskResults[0]?.message);
  assert.equal(planCalls, 1);
  assert.equal(result.taskResults[0]?.plannerUsed, true);
});

test('runIntentCapability second run uses learned reference hint without planner', async () => {
  const learnedTask: IntentTask = {
    id: 't2',
    order: 1,
    goal: 'Export CSV',
    reference_hint: { action: 'click', target: { text: 'Download CSV' } },
    verification: {
      kind: 'element_visible',
      description: 'Export complete message visible',
      spec: { text: 'Export complete' },
    },
    risk: 'low',
  };

  const planTask: PlanTaskFn = async () => {
    throw new Error('Planner should not be called on second run');
  };

  const html = `<!DOCTYPE html><html><body>
    <button type="button" onclick="document.getElementById('status').hidden=false">Download CSV</button>
    <p id="status" hidden>Export complete</p>
  </body></html>`;

  const result = await runIntentCapability({
    tasks: [learnedTask],
    headless: true,
    timeoutMs: 3_000,
    startUrl: `data:text/html,${encodeURIComponent(html)}`,
    planTask,
  });

  assert.equal(result.success, true, result.error ?? result.taskResults[0]?.message);
  assert.equal(result.plannerCalls, 0);
  assert.equal(result.taskResults[0]?.plannerUsed, false);
});
