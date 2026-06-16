import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentWorkflow } from '@browser-persona/shared';
import {
  getAutoApproveConfidenceThreshold,
  getAutoApproveDomainBlocklist,
  isAutoApproveEligible,
} from './review.ts';

const baseIntent: IntentWorkflow = {
  name: 'Export report',
  description: 'Export',
  category_path: [],
  domain: 'crm.example.com',
  parameters: [],
  tasks: [
    {
      id: 't1',
      order: 1,
      goal: 'Export',
      verification: { kind: 'download_started', description: 'download' },
      risk: 'low',
    },
  ],
  is_automatable: true,
  confidence: 0.9,
  reasoning: 'test',
};

test('isAutoApproveEligible accepts high confidence low-risk intent', () => {
  const prev = process.env.INTENT_AUTO_APPROVE_CONFIDENCE;
  process.env.INTENT_AUTO_APPROVE_CONFIDENCE = '0.85';
  assert.equal(isAutoApproveEligible(baseIntent), true);
  if (prev === undefined) delete process.env.INTENT_AUTO_APPROVE_CONFIDENCE;
  else process.env.INTENT_AUTO_APPROVE_CONFIDENCE = prev;
});

test('isAutoApproveEligible rejects high-risk tasks', () => {
  const highRisk: IntentWorkflow = {
    ...baseIntent,
    tasks: [{ ...baseIntent.tasks[0], risk: 'high' }],
  };
  assert.equal(isAutoApproveEligible(highRisk), false);
});

test('isAutoApproveEligible rejects blocklisted domains', () => {
  const prev = process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST;
  process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST = 'crm.example.com';
  assert.equal(isAutoApproveEligible(baseIntent), false);
  if (prev === undefined) delete process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST;
  else process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST = prev;
});

test('getAutoApproveConfidenceThreshold defaults to 0.85', () => {
  const prev = process.env.INTENT_AUTO_APPROVE_CONFIDENCE;
  delete process.env.INTENT_AUTO_APPROVE_CONFIDENCE;
  assert.equal(getAutoApproveConfidenceThreshold(), 0.85);
  if (prev === undefined) delete process.env.INTENT_AUTO_APPROVE_CONFIDENCE;
  else process.env.INTENT_AUTO_APPROVE_CONFIDENCE = prev;
});

test('getAutoApproveDomainBlocklist parses comma-separated domains', () => {
  const prev = process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST;
  process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST = ' PayPal.com , stripe.com ';
  assert.deepEqual(getAutoApproveDomainBlocklist(), ['paypal.com', 'stripe.com']);
  if (prev === undefined) delete process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST;
  else process.env.INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST = prev;
});
