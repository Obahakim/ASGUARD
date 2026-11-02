const { spawn } = require('node:child_process');

const [entrypoint, ...args] = process.argv.slice(2);
if (!entrypoint || !/^scripts\/demo-[a-z0-9-]+\.ts$/i.test(entrypoint)) {
  console.error('[ASGUARD demo] Expected a demo entrypoint under scripts/.');
  process.exit(1);
}

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith('ASGUARD_')) delete env[name];
}

const child = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', entrypoint, ...args], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`[ASGUARD demo] Could not start demo: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
