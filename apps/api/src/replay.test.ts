import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeForReplayer, sliceReplayEvents, type RrwebEventPayload } from './replay.ts';

const meta = (href: string, ts: number): RrwebEventPayload => ({
  type: 4,
  timestamp: ts,
  data: { href },
});

const snapshot = (ts: number): RrwebEventPayload => ({
  type: 2,
  timestamp: ts,
  data: { node: { id: 1, type: 0, childNodes: [] } },
});

const inc = (ts: number): RrwebEventPayload => ({
  type: 3,
  timestamp: ts,
  data: { source: 2, type: 2, id: 1 },
});

test('normalizeForReplayer puts meta and snapshot before incrementals', () => {
  const ordered = normalizeForReplayer([
    inc(100),
    inc(101),
    snapshot(102),
    meta('https://example.com', 99),
    inc(103),
  ]);

  assert.equal(ordered[0].type, 4);
  assert.equal(ordered[1].type, 2);
  assert.equal(ordered[2].type, 3);
  assert.equal(ordered.length, 3);
});

test('sliceReplayEvents includes snapshot from before the workflow window', () => {
  const all = [
    meta('https://rei.com', 1000),
    snapshot(1001),
    inc(1002),
    inc(1003),
    meta('https://rei.com/search', 2000),
    snapshot(2001),
    inc(2002),
    inc(2003),
  ];

  const slice = sliceReplayEvents(all, 2000, 2100);
  assert.equal(slice[0].type, 4);
  assert.equal(slice[1].type, 2);
  assert.ok(slice.length >= 3);
});

test('normalizeForReplayer throws when snapshot missing', () => {
  assert.throws(() => normalizeForReplayer([inc(1), inc(2)]), /No DOM snapshot/);
});
