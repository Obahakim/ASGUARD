export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positionals: string[];
}

export function parseArgs(args: string[], valueFlags: string[], booleanFlags: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (allowedBooleans.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value.`);
      flags.add(name);
      continue;
    }
    if (!allowedValues.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    values.set(name, value);
    if (inlineValue === undefined) index += 1;
  }
  return { flags, values, positionals };
}
