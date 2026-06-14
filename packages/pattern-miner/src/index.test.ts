import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LABEL_OVERLAP,
  detectPatterns,
  detectPatternsWithMerge,
  labelsSimilar,
  parseFingerprint,
  workflowsFuzzyMatch,
  workflowsNearMatch,
  type MinerWorkflow,
} from './index.ts';

function wf(
  id: string,
  fingerprint: string,
  domain = 'app.example.com',
): MinerWorkflow {
  return {
    id,
    fingerprint,
    primaryDomain: domain,
    stepCount: fingerprint.split('|').length,
    lastSeenAt: '2024-01-01T00:00:00.000Z',
  };
}

test('parseFingerprint splits action and label tokens', () => {
  assert.deepEqual(parseFingerprint('navigate:app.example.com/reports|click:export'), [
    { action: 'navigate', label: 'app.example.com/reports' },
    { action: 'click', label: 'export' },
  ]);
});

test('labelsSimilar matches exact, substring, and close typos', () => {
  assert.equal(labelsSimilar('Export CSV', 'export csv'), true);
  assert.equal(labelsSimilar('weekly sales', 'weekly'), true);
  assert.equal(labelsSimilar('startdate', 'start date'), true);
  assert.equal(labelsSimilar('submit', 'cancel'), false);
});

test('workflowsFuzzyMatch requires same domain and action sequence', () => {
  const base = wf('1', 'navigate:app.example.com/reports|click:export|fill:email');
  const close = wf('2', 'navigate:app.example.com/reports|click:export csv|fill:email');
  const wrongDomain = wf('3', 'navigate:app.example.com/reports|click:export|fill:email', 'other.com');
  const wrongActions = wf('4', 'navigate:app.example.com/reports|fill:email|click:export');

  assert.equal(workflowsFuzzyMatch(base, close), true);
  assert.equal(workflowsFuzzyMatch(base, wrongDomain), false);
  assert.equal(workflowsFuzzyMatch(base, wrongActions), false);
});

test('detectPatterns fuzzy-clusters near-identical workflows', () => {
  const fp1 = 'navigate:app.example.com/reports|click:weekly|fill:startdate|click:export';
  const fp2 = 'navigate:app.example.com/reports|click:weekly sales|fill:start date|click:export csv';
  const fp3 = 'navigate:app.example.com/reports|click:weekly|fill:startdate|click:export';

  const patterns = detectPatterns([wf('a', fp1), wf('b', fp2), wf('c', fp3)], {
    minOccurrences: 3,
    labelOverlap: DEFAULT_LABEL_OVERLAP,
  });

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].occurrenceCount, 3);
  assert.equal(patterns[0].workflowIds.length, 3);
});

test('detectPatterns keeps distinct workflows separate', () => {
  const patterns = detectPatterns(
    [
      wf('a', 'navigate:app.example.com/a|click:one'),
      wf('b', 'navigate:app.example.com/a|click:one'),
      wf('c', 'navigate:app.example.com/a|click:two'),
    ],
    { minOccurrences: 2 },
  );

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].occurrenceCount, 2);
  assert.deepEqual(patterns[0].workflowIds.sort(), ['a', 'b']);
});

test('detectPatterns fuzzy=false uses exact fingerprints only', () => {
  const fp1 = 'navigate:app.example.com/reports|click:export';
  const fp2 = 'navigate:app.example.com/reports|click:export csv';

  const patterns = detectPatterns([wf('a', fp1), wf('b', fp2), wf('c', fp1)], {
    minOccurrences: 2,
    fuzzy: false,
  });

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].occurrenceCount, 2);
});

test('detectPatterns transitive clustering via union-find', () => {
  const a = wf('a', 'navigate:x|click:export|fill:email');
  const b = wf('b', 'navigate:x|click:export csv|fill:email');
  const c = wf('c', 'navigate:x|click:export csv file|fill:email address');

  const patterns = detectPatterns([a, b, c], { minOccurrences: 3 });

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].occurrenceCount, 3);
});

test('workflowsNearMatch aligns shorter workflow as subsequence', () => {
  const full = wf(
    'full',
    'navigate:www.google.com/|fill:buscar|navigate:www.google.com/search|click:estadísticas|click:compartir vínculo',
    'www.google.com',
  );
  const extra = wf(
    'extra',
    'navigate:www.google.com/|fill:buscar|navigate:www.google.com/search|click:estadísticas|click:más opciones|click:compartir vínculo',
    'www.google.com',
  );
  const partial = wf('partial', 'navigate:www.google.com/|fill:buscar', 'www.google.com');

  assert.equal(workflowsNearMatch(full, extra), true);
  assert.equal(workflowsFuzzyMatch(full, extra), false);
  assert.equal(workflowsNearMatch(full, partial), false);
});

test('detectPatternsWithMerge combines near-miss clusters via LLM judge', async () => {
  const fpFull =
    'navigate:www.google.com/|fill:buscar|navigate:www.google.com/search|click:estadísticas|click:compartir vínculo';
  const fpExtra =
    'navigate:www.google.com/|fill:buscar|navigate:www.google.com/search|click:estadísticas|click:menú|click:compartir vínculo';

  const workflows = [
    wf('a1', fpFull, 'www.google.com'),
    wf('a2', fpFull, 'www.google.com'),
    wf('b1', fpExtra, 'www.google.com'),
  ];

  const result = await detectPatternsWithMerge(
    workflows,
    { minOccurrences: 3 },
    async () => ({
      samePattern: true,
      confidence: 0.95,
      reasoning: 'Same FIFA share flow with one extra menu click',
    }),
  );

  assert.equal(result.pairsJudged, 2);
  assert.equal(result.pairsMerged, 1);
  assert.equal(result.patterns.length, 1);
  assert.equal(result.patterns[0].occurrenceCount, 3);
});
