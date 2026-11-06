import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTidepoolMode } from './tidepool-mode';

test('Tidepool mode resolves approval-only by default and supports explicit modes', () => {
  assert.equal(resolveTidepoolMode(), 'approve');
  assert.equal(resolveTidepoolMode('approve'), 'approve');
  assert.equal(resolveTidepoolMode('tamper'), 'tamper');
  assert.equal(resolveTidepoolMode('onchain'), 'onchain');
});

test('Tidepool mode rejects unknown arguments with actionable usage', () => {
  assert.throws(() => resolveTidepoolMode('invalid'), /demo:onchain/);
});
