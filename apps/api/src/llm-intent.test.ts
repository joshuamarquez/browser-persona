import assert from 'node:assert/strict';
import test from 'node:test';
import { mapReferenceHints, parseIntentWorkflowLlm } from './llm-intent.ts';

const llmOutput = {
  name: 'Export report',
  description: 'Export a CSV report.',
  category_path: ['Reporting'],
  domain: 'crm.example.com',
  parameters: [],
  tasks: [
    {
      id: 't1',
      order: 1,
      goal: 'Open Reports',
      reference_step_index: 0,
      verification: {
        kind: 'url_contains',
        description: 'On reports page',
        spec: { urlPattern: '/reports' },
      },
      risk: 'low',
    },
    {
      id: 't2',
      order: 2,
      goal: 'Click export',
      verification: {
        kind: 'download_started',
        description: 'Download starts',
      },
      risk: 'medium',
    },
  ],
  is_automatable: true,
  confidence: 0.9,
  reasoning: 'Straightforward export flow.',
};

const steps = [
  {
    action: 'navigate',
    target: {},
    value: null,
    url: 'https://crm.example.com/reports',
  },
  {
    action: 'click',
    target: { text: 'Export CSV' },
    value: null,
    url: null,
  },
];

test('parseIntentWorkflowLlm validates LLM JSON', () => {
  const parsed = parseIntentWorkflowLlm(JSON.stringify(llmOutput));
  assert.equal(parsed.name, 'Export report');
  assert.equal(parsed.tasks.length, 2);
});

test('mapReferenceHints resolves reference_step_index to step data', () => {
  const parsed = parseIntentWorkflowLlm(JSON.stringify(llmOutput));
  const intent = mapReferenceHints(parsed, steps);

  assert.equal(intent.tasks[0].reference_hint?.action, 'navigate');
  assert.equal(intent.tasks[0].reference_hint?.url, 'https://crm.example.com/reports');
  assert.equal(intent.tasks[1].reference_hint?.action, 'click');
  assert.deepEqual(intent.tasks[1].reference_hint?.target, { text: 'Export CSV' });
});

test('parseIntentWorkflowLlm normalizes string parameters and url_equals verification', () => {
  const raw = {
    ...llmOutput,
    parameters: ['report_date'],
    tasks: [
      {
        ...llmOutput.tasks[0],
        verification: {
          kind: 'url_equals',
          description: 'Landed on reports',
          spec: { urlPattern: 'https://crm.example.com/reports' },
        },
      },
    ],
  };
  const parsed = parseIntentWorkflowLlm(JSON.stringify(raw));
  assert.deepEqual(parsed.parameters, [{ name: 'report_date', type: 'string' }]);
  assert.equal(parsed.tasks[0].verification.kind, 'url_matches');
});

test('mapReferenceHints falls back to order-based step when no index', () => {
  const noIndex = {
    ...llmOutput,
    tasks: [
      {
        ...llmOutput.tasks[0],
        reference_step_index: undefined,
      },
    ],
  };
  const intent = mapReferenceHints(parseIntentWorkflowLlm(JSON.stringify(noIndex)), steps);
  assert.equal(intent.tasks[0].reference_hint?.action, 'navigate');
});
