import test from 'node:test';
import assert from 'node:assert/strict';
import { offerPostSetupActions, shouldOfferSetupActions } from './setupActions';

test('post-setup actions are restricted to interactive successful setup mode', () => {
  assert.equal(shouldOfferSetupActions({ interactiveTTY: true, yes: false, check: false }), true);
  assert.equal(shouldOfferSetupActions({ interactiveTTY: false, yes: false, check: false }), false);
  assert.equal(shouldOfferSetupActions({ interactiveTTY: true, yes: true, check: false }), false);
  assert.equal(shouldOfferSetupActions({ interactiveTTY: true, yes: false, check: true }), false);
});

test('--yes and non-TTY modes never start the server or open a browser', async () => {
  let starts = 0;
  let opens = 0;
  const options = {
    interactiveTTY: false, yes: true, check: false,
    prompter: { confirm: async () => true },
    startDevStack: async () => { starts += 1; return true; },
    openDashboard: async () => { opens += 1; return true; },
    log: () => undefined,
  };
  await offerPostSetupActions(options);
  await offerPostSetupActions({ ...options, interactiveTTY: true, yes: true });
  assert.equal(starts, 0);
  assert.equal(opens, 0);
});

test('declining stack start does not open browser', async () => {
  let opens = 0;
  const lines: string[] = [];
  await offerPostSetupActions({
    interactiveTTY: true, yes: false, check: false,
    prompter: { confirm: async () => false },
    openDashboard: async () => { opens += 1; return true; },
    log: (message) => lines.push(message),
  });
  assert.equal(opens, 0);
  assert.ok(lines.includes('Setup complete. Start later with: npm run dev'));
});

test('browser opening happens only after readiness and only when a browser is available', async () => {
  let starts = 0;
  let opens = 0;
  const lines: string[] = [];
  await offerPostSetupActions({
    interactiveTTY: true, yes: false, check: false,
    prompter: { confirm: async () => true },
    startDevStack: async () => { starts += 1; return true; },
    openDashboard: async () => { opens += 1; return false; },
    browserAvailable: () => false,
    log: (message) => lines.push(message),
  });
  assert.equal(starts, 1);
  assert.equal(opens, 0);
  assert.ok(lines.includes('No graphical browser is available. Open manually: http://localhost:3000'));

  await offerPostSetupActions({
    interactiveTTY: true, yes: false, check: false,
    prompter: { confirm: async () => true },
    startDevStack: async () => { starts += 1; return true; },
    openDashboard: async () => { opens += 1; return false; },
    browserAvailable: () => true,
    log: (message) => lines.push(message),
  });
  assert.equal(starts, 2);
  assert.equal(opens, 1);
  assert.ok(lines.includes('Could not open a browser. Open manually: http://localhost:3000'));
});
