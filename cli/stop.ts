import { stopDevStack } from './lib/devStack';

void stopDevStack().then((stopped) => {
  process.exitCode = stopped ? 0 : 1;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown shutdown error.';
  console.error(`[ASGUARD stop] ${message}`);
  process.exitCode = 1;
});
