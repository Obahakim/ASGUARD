import type { Prompter } from './prompt';
import { canOpenBrowser, openDashboard, startDevStack } from './devStack';

export { openDashboard, startDevStack } from './devStack';

export interface SetupActionOptions {
  interactiveTTY: boolean;
  yes: boolean;
  check: boolean;
  prompter: Pick<Prompter, 'confirm'>;
  log?: (message: string) => void;
  startDevStack?: () => Promise<boolean>;
  openDashboard?: () => Promise<boolean>;
  browserAvailable?: () => boolean;
  onReady?: () => Promise<void> | void;
}

export function shouldOfferSetupActions(options: Pick<SetupActionOptions, 'interactiveTTY' | 'yes' | 'check'>): boolean {
  return options.interactiveTTY && !options.yes && !options.check;
}

export async function offerPostSetupActions(options: SetupActionOptions): Promise<void> {
  if (!shouldOfferSetupActions(options)) return;
  const log = options.log || console.log;
  log('Next steps: npm run dev starts the backend and dashboard. Your dashboard token is in .asguard/dashboard-token.txt.');
  const browserAvailable = (options.browserAvailable || canOpenBrowser)();
  if (!await options.prompter.confirm('Start ASGUARD now?', true)) {
    log('Setup complete. Start later with: npm run dev');
    return;
  }
  if (!await (options.startDevStack || startDevStack)()) {
    log('The dev stack did not become ready. See .asguard/dev.log; stop it with npm run stop or run npm run dev manually.');
    return;
  }
  await options.onReady?.();
  if (!browserAvailable) {
    log('No graphical browser is available. Open manually: http://localhost:3000');
    return;
  }
  if (!await options.prompter.confirm('Open the dashboard in your browser?', true)) return;
  if (!await (options.openDashboard || openDashboard)()) {
    log('Could not open a browser. Open manually: http://localhost:3000');
  }
}
