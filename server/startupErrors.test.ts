import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditChainIntegrityError } from './auditChain';
import { formatStartupError } from '../scripts/start-backend';

test('startup error mapping gives an actionable audit-chain message without a stack', () => {
  const message = formatStartupError(new AuditChainIntegrityError('.asguard/state/audit_chain.json'));
  assert.equal(message, 'ASGUARD cannot start: the audit chain at .asguard/state/audit_chain.json was signed with a different ASGUARD_AUDIT_KEY.\nFix one of:\n  - restore the original audit key in .env, or\n  - archive the old chain and start fresh: npm run setup -- --reset-state');
  assert.equal(message.includes('   at '), false);
});

test('startup error mapping includes the busy port and stop instructions', () => {
  const error = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE', port: 8088 });
  assert.equal(
    formatStartupError(error),
    'Port 8088 is already in use. If ASGUARD is already running, stop it with npm run stop; otherwise change ASGUARD_PORT in .env.',
  );
});
