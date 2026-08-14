export interface DaytonaClientConfig {
  daytonaApiKey: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
}

export function requireDaytonaClientConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DaytonaClientConfig {
  const daytonaApiKey = environment.DAYTONA_API_KEY;
  if (!daytonaApiKey) throw new Error("DAYTONA_API_KEY is required");
  return {
    daytonaApiKey,
    daytonaApiUrl: environment.DAYTONA_API_URL,
    daytonaTarget: environment.DAYTONA_TARGET,
  };
}

export function daytonaClientOptions(config: DaytonaClientConfig): {
  apiKey: string;
  apiUrl?: string;
  target?: string;
} {
  return {
    apiKey: config.daytonaApiKey,
    apiUrl: config.daytonaApiUrl,
    target: config.daytonaTarget,
  };
}
