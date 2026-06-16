import assert from 'node:assert/strict';
import test from 'node:test';
import { getRrwebRetentionDays } from './retention.ts';

test('getRrwebRetentionDays defaults to 14', () => {
  const prev = process.env.RRWEB_RETENTION_DAYS;
  delete process.env.RRWEB_RETENTION_DAYS;
  assert.equal(getRrwebRetentionDays(), 14);
  process.env.RRWEB_RETENTION_DAYS = '7';
  assert.equal(getRrwebRetentionDays(), 7);
  if (prev === undefined) delete process.env.RRWEB_RETENTION_DAYS;
  else process.env.RRWEB_RETENTION_DAYS = prev;
});
