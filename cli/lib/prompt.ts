import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

type Validator = (value: string) => string | undefined;

export class PromptAbortError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = 'PromptAbortError';
  }
}

export interface Prompter {
  ask(question: string, options?: { default?: string; validate?: Validator }): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  confirmTyped(question: string, expected: string): Promise<void>;
  choose(question: string, options: string[], chooseOptions?: { defaultIndex?: number | null }): Promise<string>;
  askSecret(question: string, options?: { validate?: Validator }): Promise<string>;
}

export function createPrompter(options: {
  input: Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  output: Writable;
  isTTY: boolean;
  noColor?: boolean;
}): Prompter {
  const color = !options.noColor && process.env.NO_COLOR === undefined;
  const paint = (value: string) => color ? `\u001b[36m${value}\u001b[0m` : value;

  async function readLine(prompt: string): Promise<string> {
    const interfaceInstance = createInterface({ input: options.input, output: options.output });
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          interfaceInstance.off('close', onClose);
          interfaceInstance.off('SIGINT', onSigint);
          action();
        };
        const onClose = () => finish(() => reject(new PromptAbortError('Input closed. Nothing was changed.')));
        const onSigint = () => finish(() => reject(new PromptAbortError('Cancelled.', 130)));
        interfaceInstance.once('close', onClose);
        interfaceInstance.once('SIGINT', onSigint);
        void interfaceInstance.question(prompt).then(
          (answer) => finish(() => resolve(answer.trim())),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    } finally {
      interfaceInstance.close();
    }
  }

  async function ask(
    question: string,
    askOptions: { default?: string; defaultLabel?: string; validate?: Validator } = {},
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const suffix = askOptions.default === undefined ? '' : ` [${askOptions.default}]`;
      let value = await readLine(`${paint(question)}${suffix}: `);
      if (!value && askOptions.default !== undefined) value = askOptions.default;
      const invalid = askOptions.validate?.(value);
      if (!invalid) return value;
      options.output.write(`${invalid}\n`);
      if (askOptions.default !== undefined) options.output.write(`Press Enter for ${askOptions.defaultLabel || askOptions.default}.\n`);
    }
    if (askOptions.default !== undefined && !askOptions.validate?.(askOptions.default)) {
      options.output.write(`Using default: ${askOptions.defaultLabel || askOptions.default}.\n`);
      return askOptions.default;
    }
    throw new PromptAbortError('No valid answer was given. Nothing was changed.');
  }

  async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const defaultValue = defaultYes ? 'yes' : 'no';
    const value = await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`, {
      default: defaultValue,
      validate: (answer) => ['y', 'yes', 'n', 'no'].includes(answer.toLowerCase())
        ? undefined : 'Enter y, yes, n, or no.',
    });
    return value.toLowerCase() === 'y' || value.toLowerCase() === 'yes';
  }

  async function confirmTyped(question: string, expected: string): Promise<void> {
    const value = await readLine(`${paint(question)}: `);
    if (value !== expected) throw new PromptAbortError('Confirmation did not match. Nothing was changed.');
  }

  async function choose(
    question: string,
    choices: string[],
    chooseOptions: { defaultIndex?: number | null } = {},
  ): Promise<string> {
    if (!choices.length) throw new Error('At least one choice is required.');
    const defaultIndex = chooseOptions.defaultIndex === undefined ? 0 : chooseOptions.defaultIndex;
    if (defaultIndex !== null && (!Number.isInteger(defaultIndex) || defaultIndex < 0 || defaultIndex >= choices.length)) {
      throw new Error('The default choice index is out of range.');
    }
    const labels = choices.map((choice, index) => `${index + 1}) ${choice}`).join('  ');
    const defaultChoice = defaultIndex === null ? undefined : choices[defaultIndex];
    const value = await ask(`${question} ${labels}`, {
      ...(defaultIndex === null ? {} : { default: String(defaultIndex + 1) }),
      ...(defaultIndex === null ? {} : { defaultLabel: `${defaultIndex + 1}) ${defaultChoice}` }),
      validate: (answer) => {
        const normalized = answer.toLowerCase();
        const matches = choices.filter((choice) => choice.toLowerCase().startsWith(normalized));
        return choices.some((choice) => choice.toLowerCase() === normalized)
          || choices.some((_, index) => answer === String(index + 1))
          || (normalized.length > 0 && matches.length === 1)
          ? undefined : 'Choose one of the listed options.';
      },
    });
    const normalized = value.toLowerCase();
    const exact = choices.find((choice) => choice.toLowerCase() === normalized);
    if (exact) return exact;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) return choices[numeric - 1];
    return choices.find((choice) => choice.toLowerCase().startsWith(normalized)) || defaultChoice || choices[0];
  }

  async function askSecret(question: string, secretOptions: { validate?: Validator } = {}): Promise<string> {
    if (!options.isTTY) throw new Error('Secret input requires a TTY; provide the value using a supported environment variable or flag.');
    const input = options.input;
    const visibleFallback = () => {
      options.output.write('Warning: hidden input is unavailable in this terminal; the next secret will be visible while you type.\n');
      return ask(`${question} (visible fallback)`, { validate: secretOptions.validate });
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options.output.write(`${paint(question)} (input hidden): `);
      if (!(input.isTTY && input.setRawMode)) return visibleFallback();
      try {
        input.setRawMode(true);
      } catch {
        return visibleFallback();
      }
      let value = '';
      try {
        value = await new Promise<string>((resolve, reject) => {
          const onData = (chunk: Buffer | string) => {
            for (const character of chunk.toString()) {
              if (character === '\u0003') {
                cleanup();
                reject(new PromptAbortError('Cancelled.', 130));
                return;
              }
              if (character === '\r' || character === '\n') {
                cleanup();
                options.output.write('\n');
                resolve(value);
                return;
              }
              if (character === '\u0015') value = '';
              else if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
              else if (character >= ' ') value += character;
            }
          };
          const onEnd = () => {
            cleanup();
            reject(new PromptAbortError('Input closed. Nothing was changed.'));
          };
          const cleanup = () => {
            input.off('data', onData);
            input.off('end', onEnd);
          };
          input.on('data', onData);
          input.once('end', onEnd);
        });
      } finally {
        try { input.setRawMode(false); } catch {
          options.output.write('Warning: this terminal could not restore hidden-input mode.\n');
        }
      }
      const invalid = secretOptions.validate?.(value);
      if (!invalid) return value;
      options.output.write(`${invalid}\n`);
    }
    throw new PromptAbortError('No valid answer was given. Nothing was changed.');
  }

  return { ask, confirm, confirmTyped, choose, askSecret };
}
