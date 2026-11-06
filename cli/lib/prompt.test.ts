import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter, PromptAbortError } from './prompt';

function promptWithInput(): { input: PassThrough; output: PassThrough; prompter: ReturnType<typeof createPrompter>; text: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  return {
    input,
    output,
    prompter: createPrompter({ input, output, isTTY: false, noColor: true }),
    text: () => written,
  };
}

function send(input: PassThrough, ...answers: string[]): void {
  answers.forEach((answer, index) => setTimeout(() => input.write(`${answer}\n`), index * 10));
}

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

test('optional public account prompts accept blank input as skip', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = createPrompter({ input, output, isTTY: false, noColor: true });
  const pending = prompter.ask('Account (leave empty to skip)', {
    validate: (value) => !value || /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value) ? undefined : 'Enter an account or leave empty.',
  });
  setTimeout(() => input.write('\n'), 0);
  assert.equal(await pending, '');
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

test('ask accepts its default when Enter is pressed', async () => {
  const { input, output, prompter } = promptWithInput();
  const pending = prompter.ask('Value', { default: 'safe' });
  send(input, '');
  assert.equal(await pending, 'safe');
  input.destroy();
  output.destroy();
});

test('ask uses a valid default after three invalid answers', async () => {
  const { input, output, prompter, text } = promptWithInput();
  const pending = prompter.ask('Port', { default: '8080', validate: (value) => /^\d+$/.test(value) ? undefined : 'Enter a number.' });
  send(input, 'no', 'still no', 'bad');
  assert.equal(await pending, '8080');
  assert.match(text(), /Press Enter for 8080/);
  assert.match(text(), /Using default: 8080\./);
  input.destroy();
  output.destroy();
});

test('ask aborts safely after three invalid answers without a default', async () => {
  const { input, output, prompter } = promptWithInput();
  const pending = prompter.ask('Value', { validate: () => 'Invalid.' });
  send(input, 'x', 'y', 'z');
  await assert.rejects(pending, (error: unknown) =>
    error instanceof PromptAbortError && error.message === 'No valid answer was given. Nothing was changed.');
  input.destroy();
  output.destroy();
});

test('choose accepts number, exact label, and a unique case-insensitive prefix', async () => {
  const cases: Array<[string, string]> = [['2', 'beta'], ['Gamma', 'gamma'], ['ALP', 'alpha']];
  for (const [answer, expected] of cases) {
    const { input, output, prompter } = promptWithInput();
    const pending = prompter.choose('Choice', ['alpha', 'beta', 'gamma']);
    send(input, answer);
    assert.equal(await pending, expected);
    input.destroy();
    output.destroy();
  }
});

test('choose Enter selects the default and ambiguous prefixes are rejected', async () => {
  const empty = promptWithInput();
  const selected = empty.prompter.choose('Choice', ['alpha', 'alpine', 'beta']);
  send(empty.input, '');
  assert.equal(await selected, 'alpha');
  empty.input.destroy();
  empty.output.destroy();

  const ambiguous = promptWithInput();
  const retried = ambiguous.prompter.choose('Choice', ['alpha', 'alpine', 'beta']);
  send(ambiguous.input, 'al', 'al', 'al');
  assert.equal(await retried, 'alpha');
  assert.match(ambiguous.text(), /Choose one of the listed options\./);
  ambiguous.input.destroy();
  ambiguous.output.destroy();
});

test('choose with no default aborts after three invalid answers', async () => {
  const { input, output, prompter } = promptWithInput();
  const pending = prompter.choose('Choice', ['alpha', 'beta'], { defaultIndex: null });
  send(input, '', 'unknown', '0');
  await assert.rejects(pending, PromptAbortError);
  input.destroy();
  output.destroy();
});

test('confirm handles accepted variants and falls back after invalid answers', async () => {
  const cases: Array<[string, boolean]> = [['Y', true], ['yes', true], ['n', false], ['NO', false], ['', true]];
  for (const [answer, expected] of cases) {
    const { input, output, prompter } = promptWithInput();
    const pending = prompter.confirm('Continue?', true);
    send(input, answer);
    assert.equal(await pending, expected);
    input.destroy();
    output.destroy();
  }

  const fallback = promptWithInput();
  const pending = fallback.prompter.confirm('Continue?', false);
  send(fallback.input, 'perhaps', '?', 'later');
  assert.equal(await pending, false);
  assert.match(fallback.text(), /Using default: no\./);
  fallback.input.destroy();
  fallback.output.destroy();
});

test('typed confirmation mismatch and closed input abort safely', async () => {
  const mismatch = promptWithInput();
  const typed = mismatch.prompter.confirmTyped('Type reset', 'reset');
  send(mismatch.input, 'no');
  await assert.rejects(typed, /Confirmation did not match\. Nothing was changed\./);
  mismatch.input.destroy();
  mismatch.output.destroy();

  const closed = promptWithInput();
  const pending = closed.prompter.ask('Value');
  closed.input.end();
  await assert.rejects(pending, /Input closed\. Nothing was changed\./);
  closed.output.destroy();
});

test('secret input returns a safe cancellation when its stream closes', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  const prompter = createPrompter({ input, output, isTTY: true, noColor: true });
  const pending = prompter.askSecret('Token');
  input.end();
  await assert.rejects(pending, /Input closed\. Nothing was changed\./);
  input.destroy();
  output.destroy();
});
