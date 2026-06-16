import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isIntentWorkflow,
  isTaskRisk,
  isVerificationKind,
  maxTaskRisk,
  type IntentTask,
  type IntentWorkflow,
} from './index.ts';

const sampleIntent: IntentWorkflow = {
  name: 'Export weekly sales report',
  description: 'Download a CSV sales report for a given date range.',
  category_path: ['Reporting', 'Sales'],
  domain: 'crm.example.com',
  parameters: [{ name: 'start_date', type: 'date', example: '2026-06-01' }],
  tasks: [
    {
      id: 't1',
      order: 1,
      goal: 'Open the Reports area',
      verification: {
        kind: 'url_contains',
        description: 'URL includes /reports',
        spec: { urlPattern: '/reports' },
      },
      risk: 'low',
    },
    {
      id: 't2',
      order: 2,
      goal: 'Export CSV',
      verification: { kind: 'download_started', description: 'Download begins' },
      risk: 'medium',
    },
  ],
  is_automatable: true,
  confidence: 0.89,
  reasoning: 'Clear export sequence.',
};

test('type guards accept valid intent values', () => {
  assert.equal(isTaskRisk('low'), true);
  assert.equal(isTaskRisk('high'), true);
  assert.equal(isTaskRisk('critical'), false);
  assert.equal(isVerificationKind('url_contains'), true);
  assert.equal(isVerificationKind('click'), false);
  assert.equal(isIntentWorkflow(sampleIntent), true);
  assert.equal(isIntentWorkflow({ name: 'x' }), false);
});

test('maxTaskRisk returns highest tier present', () => {
  assert.equal(maxTaskRisk(sampleIntent.tasks), 'medium');
  const highTask: IntentTask = { ...sampleIntent.tasks[0], risk: 'high' };
  assert.equal(maxTaskRisk([highTask, sampleIntent.tasks[1]]), 'high');
  assert.equal(maxTaskRisk([sampleIntent.tasks[0]]), 'low');
});

test('IntentWorkflow JSON round-trip preserves shape', () => {
  const parsed = JSON.parse(JSON.stringify(sampleIntent)) as unknown;
  assert.equal(isIntentWorkflow(parsed), true);
  assert.deepEqual(parsed, sampleIntent);
});
