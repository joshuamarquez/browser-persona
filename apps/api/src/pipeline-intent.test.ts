import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isIntentExtractAutoEnabled,
  shouldSkipNonAutomatableIntent,
} from './pipeline.ts';

test('isIntentExtractAutoEnabled defaults true when API key present', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevFlag = process.env.INTENT_EXTRACT_AUTO;
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.INTENT_EXTRACT_AUTO;
  assert.equal(isIntentExtractAutoEnabled(), true);
  process.env.INTENT_EXTRACT_AUTO = 'false';
  assert.equal(isIntentExtractAutoEnabled(), false);
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
  if (prevFlag === undefined) delete process.env.INTENT_EXTRACT_AUTO;
  else process.env.INTENT_EXTRACT_AUTO = prevFlag;
});

test('shouldSkipNonAutomatableIntent defaults true', () => {
  const prev = process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE;
  delete process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE;
  assert.equal(shouldSkipNonAutomatableIntent(), true);
  process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE = 'false';
  assert.equal(shouldSkipNonAutomatableIntent(), false);
  if (prev === undefined) delete process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE;
  else process.env.INTENT_EXTRACT_SKIP_NON_AUTOMATABLE = prev;
});
