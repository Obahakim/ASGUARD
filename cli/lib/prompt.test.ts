import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from './prompt';

test('secret input masks characters, supports backspace, and retries validation', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  const prompter = createPrompter({ input, output, isTTY: true, noColor: true });
  const pending = prompter.askSecret('Token', { validate: (value) => value.length >= 3 ? undefined : 'Too short.' });
  setTimeout(() => input.write('x\n'), 0);
  setTimeout(() => input.write('secret\x7f!\n'), 10);
  assert.equal(await pending, 'secre!');
  assert.equal(written.includes('x'), false);
  assert.equal(written.includes('secret'), false);
  assert.match(written, /Too short/);
  input.destroy();
  output.destroy();
});

test('secret input falls back visibly when Windows cannot enable raw mode', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => { throw new Error('raw mode unavailable'); };
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  const prompter = createPrompter({ input, output, isTTY: true, noColor: true });
  const pending = prompter.askSecret('Token');
  setTimeout(() => input.write('visible-secret\n'), 0);
  assert.equal(await pending, 'visible-secret');
  assert.match(written, /Warning: hidden input is unavailable/);
  input.destroy();
  output.destroy();
});

test('secret input rejects non-TTY use', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = createPrompter({ input, output, isTTY: false });
  await assert.rejects(prompter.askSecret('Token'), /requires a TTY/);
  input.destroy();
  output.destroy();
});

test('Ctrl-C exits with 130 and restores raw mode', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (enabled) => { rawModes.push(enabled); };
  const output = new PassThrough();
  const prompter = createPrompter({ input, output, isTTY: true, noColor: true });
  const pending = prompter.askSecret('Token');
  setTimeout(() => input.write('\u0003'), 0);
  await assert.rejects(pending, (error: unknown) =>
    typeof error === 'object' && error !== null && 'exitCode' in error && error.exitCode === 130);
  assert.deepEqual(rawModes, [true, false]);
  input.destroy();
  output.destroy();
});
