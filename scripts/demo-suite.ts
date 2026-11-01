import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runDemo } from './demo-common';
import { runNearScenario, type NearDemoMode, type NearDemoScenario } from './demo-near-runner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScenario(value: unknown, index: number): NearDemoScenario {
  if (!isRecord(value) || !['approve', 'hitl', 'block'].includes(String(value.mode))) {
    throw new Error(`Scenario ${index + 1} must be an object with mode "approve", "hitl", or "block".`);
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim())) {
    throw new Error(`Scenario ${index + 1}: name must be a non-empty string.`);
  }
  if (value.agentId !== undefined && (typeof value.agentId !== 'string' || !value.agentId.trim())) {
    throw new Error(`Scenario ${index + 1}: agentId must be a non-empty string.`);
  }
  if (value.intent !== undefined && !isRecord(value.intent)) {
    throw new Error(`Scenario ${index + 1}: intent must be a JSON object.`);
  }
  return {
    mode: value.mode as NearDemoMode,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.riskLevel === 'string' ? { riskLevel: value.riskLevel as NearDemoScenario['riskLevel'] } : {}),
    ...(isRecord(value.intent) ? { intent: value.intent } : {}),
  };
}

function scenariosFromFile(filePath: string): NearDemoScenario[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
  } catch (error) {
    throw new Error(`Could not read demo scenario file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(`"${filePath}" must contain a non-empty "scenarios" array.`);
  }
  return parsed.scenarios.map(parseScenario);
}

function readScenarios(args: string[]): NearDemoScenario[] {
  let filePath: string | undefined;
  const requestedModes: NearDemoMode[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file') {
      filePath = args[index + 1];
      if (!filePath || filePath.startsWith('--')) throw new Error('Usage: demo:suite --file <scenario.json>.');
      index += 1;
    } else if (arg === '--scenario') {
      const mode = args[index + 1];
      if (mode !== 'approve' && mode !== 'hitl' && mode !== 'block') {
        throw new Error('Each --scenario must be approve, hitl, or block.');
      }
      requestedModes.push(mode);
      index += 1;
    } else {
      throw new Error(`Unknown option "${arg}". Use --file <scenario.json> or --scenario approve|hitl|block.`);
    }
  }
  if (filePath && requestedModes.length > 0) throw new Error('Choose either --file or repeated --scenario options, not both.');
  if (filePath) return scenariosFromFile(filePath);
  if (requestedModes.length === 0) {
    throw new Error('Usage: npm run demo:suite -- --scenario approve --scenario hitl --scenario block, or use --file <scenario.json>.');
  }
  return requestedModes.map((mode) => ({ mode }));
}

void runDemo('demo:suite', async (config) => {
  const scenarios = readScenarios(process.argv.slice(2));
  console.log(`Running ${scenarios.length} scenario(s) sequentially. Resolve pending HITL requests in the dashboard before the 3-minute timeout.`);
  let failed = false;
  for (const [index, scenario] of scenarios.entries()) {
    try {
      await runNearScenario(config, { ...scenario, name: scenario.name || `scenario-${index + 1}-${scenario.mode}` });
    } catch (error) {
      failed = true;
      console.error(`Scenario ${scenario.name || scenario.mode} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) throw new Error('One or more scenarios failed. Review their output above; later scenarios were still attempted.');
  console.log('Demo suite completed. No scenario signed or submitted a transaction.');
});
