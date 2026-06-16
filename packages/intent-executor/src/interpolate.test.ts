import assert from 'node:assert/strict';
import test from 'node:test';
import { interpolateParams } from './interpolate.ts';

test('interpolateParams replaces placeholders', () => {
  assert.equal(
    interpolateParams('From {{start_date}} to {{end_date}}', {
      start_date: '2026-06-01',
      end_date: '2026-06-07',
    }),
    'From 2026-06-01 to 2026-06-07',
  );
});

test('interpolateParams leaves unknown keys unchanged', () => {
  assert.equal(interpolateParams('/reports/{{id}}', {}), '/reports/{{id}}');
});
