import { runDemo } from './demo-common';
import { runNearScenario, type NearDemoMode } from './demo-near-runner';

const mode = process.argv[2] || 'approve';

void runDemo(`demo:near:${mode}`, async (config) => {
  if (!['approve', 'hitl', 'block'].includes(mode)) {
    throw new Error('Usage: npm run demo:near:approve | demo:near:hitl | demo:near:block.');
  }
  await runNearScenario(config, { mode: mode as NearDemoMode });
});
