import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNearFunctionCallStringResult } from './nearFunctionResult';

function bytes(value: string): number[] {
  return [...Buffer.from(value, 'utf8')];
}

test('NEAR view-function result decodes a JSON-encoded USDC balance string', () => {
  assert.equal(parseNearFunctionCallStringResult(bytes('"100000"')), '100000');
  assert.equal(parseNearFunctionCallStringResult(bytes('"0"')), '0');
});

test('NEAR view-function result accepts a plain integer response', () => {
  assert.equal(parseNearFunctionCallStringResult(bytes('100000')), '100000');
});

test('NEAR view-function result rejects malformed JSON, non-integer values, and invalid bytes', () => {
  for (const result of [bytes('"not-a-number"'), bytes('"unterminated'), bytes('1.5'), [256], null]) {
    assert.throws(() => parseNearFunctionCallStringResult(result), /balance response was invalid/);
  }
});
