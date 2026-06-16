import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanOutput } from './llm-plan.ts';

test('parsePlanOutput validates planner JSON', () => {
  const raw = JSON.stringify({
    actions: [{ action: 'click', target: { text: 'Export CSV' } }],
    reasoning: 'Click export button',
    confidence: 0.88,
  });
  const plan = parsePlanOutput(raw);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].action, 'click');
  assert.equal(plan.confidence, 0.88);
});

test('parsePlanOutput rejects empty actions', () => {
  assert.throws(
    () =>
      parsePlanOutput(
        JSON.stringify({ actions: [], reasoning: 'none', confidence: 0.5 }),
      ),
    /at least 1 element/i,
  );
});
