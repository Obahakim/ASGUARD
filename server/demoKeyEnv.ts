export function stripDemoPrivateKeysFromEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment.ASGUARD_DEMO_NEAR_PRIVATE_KEY;
  delete environment.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY;
}
