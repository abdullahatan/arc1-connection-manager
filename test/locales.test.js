import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLocales } from '../scripts/check-locales.mjs';

test('every language has every text with the same placeholders', () => {
  assert.deepEqual(checkLocales(), []);
});
