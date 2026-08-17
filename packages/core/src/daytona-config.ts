export interface DaytonaClientConfig {
  daytonaApiKey: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
}

function optionalDaytonaApiUrl(value: string | undefined): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("DAYTONA_API_URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("DAYTONA_API_URL must be an absolute HTTPS URL");
  }
  if (url.username || url.password) {
    throw new Error("DAYTONA_API_URL cannot contain credentials");
  }
  if (url.hash) {
    throw new Error("DAYTONA_API_URL cannot contain a fragment");
  }
  if (url.search) {
    throw new Error("DAYTONA_API_URL cannot contain query parameters");
  }
  return url.toString();
}

export function requireDaytonaClientConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DaytonaClientConfig {
  const daytonaApiKey = environment.DAYTONA_API_KEY;
  if (!daytonaApiKey) throw new Error("DAYTONA_API_KEY is required");
  return {
    daytonaApiKey,
    daytonaApiUrl: optionalDaytonaApiUrl(environment.DAYTONA_API_URL),
    daytonaTarget: environment.DAYTONA_TARGET?.trim() || undefined,
  };
}

export function isDaytonaNotFound(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "DaytonaNotFoundError") ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404)
  );
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
