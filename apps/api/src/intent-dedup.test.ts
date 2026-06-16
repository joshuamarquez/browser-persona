import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentWorkflow } from '@browser-persona/shared';
import {
  buildCapabilityEmbeddingText,
  buildIntentEmbeddingText,
  cosineSimilarity,
  getDedupSimilarityHigh,
  getDedupSimilarityLow,
} from './intent-dedup.ts';

const sampleIntent: IntentWorkflow = {
  name: 'Export weekly sales report',
  description: 'Download CSV',
  category_path: ['Reporting'],
  domain: 'crm.example.com',
  parameters: [],
  tasks: [
    {
      id: 't1',
      order: 1,
      goal: 'Open Reports',
      verification: { kind: 'url_contains', description: 'reports' },
      risk: 'low',
    },
    {
      id: 't2',
      order: 2,
      goal: 'Export CSV',
      verification: { kind: 'download_started', description: 'download' },
      risk: 'medium',
    },
  ],
  is_automatable: true,
  confidence: 0.9,
  reasoning: 'test',
};

test('buildIntentEmbeddingText includes domain, name, and ordered goals', () => {
  const text = buildIntentEmbeddingText(sampleIntent);
  assert.match(text, /crm\.example\.com/);
  assert.match(text, /Export weekly sales report/);
  assert.ok(text.indexOf('Open Reports') < text.indexOf('Export CSV'));
});

test('buildCapabilityEmbeddingText matches intent format', () => {
  const fromIntent = buildIntentEmbeddingText(sampleIntent);
  const fromCap = buildCapabilityEmbeddingText(
    sampleIntent.name,
    sampleIntent.domain,
    sampleIntent.tasks,
  );
  assert.equal(fromIntent, fromCap);
});

test('cosineSimilarity returns 1 for identical vectors', () => {
  const v = [0.2, 0.5, 0.9];
  assert.equal(cosineSimilarity(v, v), 1);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('dedup similarity thresholds have sensible defaults', () => {
  const prevHigh = process.env.INTENT_DEDUP_SIMILARITY_HIGH;
  const prevLow = process.env.INTENT_DEDUP_SIMILARITY_LOW;
  delete process.env.INTENT_DEDUP_SIMILARITY_HIGH;
  delete process.env.INTENT_DEDUP_SIMILARITY_LOW;
  assert.equal(getDedupSimilarityHigh(), 0.92);
  assert.equal(getDedupSimilarityLow(), 0.8);
  if (prevHigh === undefined) delete process.env.INTENT_DEDUP_SIMILARITY_HIGH;
  else process.env.INTENT_DEDUP_SIMILARITY_HIGH = prevHigh;
  if (prevLow === undefined) delete process.env.INTENT_DEDUP_SIMILARITY_LOW;
  else process.env.INTENT_DEDUP_SIMILARITY_LOW = prevLow;
});
