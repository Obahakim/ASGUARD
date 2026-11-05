import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

type Validator = (value: string) => string | undefined;

export interface Prompter {
  ask(question: string, options?: { default?: string; validate?: Validator }): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  choose(question: string, options: string[]): Promise<string>;
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

  async function ask(question: string, askOptions: { default?: string; validate?: Validator } = {}): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = askOptions.default === undefined ? '' : ` [${askOptions.default}]`;
      const interfaceInstance = createInterface({ input: options.input, output: options.output });
      let value: string;
      try {
        value = (await interfaceInstance.question(`${paint(question)}${suffix}: `)).trim();
      } finally {
        interfaceInstance.close();
      }
      if (!value && askOptions.default !== undefined) value = askOptions.default;
      const invalid = askOptions.validate?.(value);
      if (!invalid) return value;
      options.output.write(`${invalid}\n`);
    }
    throw Object.assign(new Error('Too many invalid responses.'), { exitCode: 1 });
  }

  async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const value = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
    return value ? value === 'y' || value === 'yes' : defaultYes;
  }

  async function choose(question: string, choices: string[]): Promise<string> {
    const labels = choices.map((choice, index) => `${index + 1}) ${choice}`).join('  ');
    const value = await ask(`${question} ${labels}`, {
      validate: (answer) => choices.includes(answer) || choices.some((_, index) => answer === String(index + 1))
        ? undefined : 'Choose one of the listed options.',
    });
    return choices.find((_, index) => value === String(index + 1)) ?? value;
  }

  async function askSecret(question: string, secretOptions: { validate?: Validator } = {}): Promise<string> {
    if (!options.isTTY) throw new Error('Secret input requires a TTY; provide the value using a supported environment variable or flag.');
    const input = options.input;
    const visibleFallback = () => {
      options.output.write('Warning: hidden input is unavailable in this terminal; the next secret will be visible while you type.\n');
      return ask(`${question} (visible fallback)`, { validate: secretOptions.validate });
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
                reject(Object.assign(new Error('Cancelled.'), { exitCode: 130 }));
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
          const cleanup = () => input.off('data', onData);
          input.on('data', onData);
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
    throw Object.assign(new Error('Too many invalid responses.'), { exitCode: 1 });
  }

  return { ask, confirm, choose, askSecret };
}
