import { renderInvestigationPromptPart, type InvestigationPromptParts } from "@responder/core/investigations/prompt-parts";

const daytonaSecretPlaceholderPattern = /dtn_secret_[a-z0-9_-]+/giu;

export function redactDaytonaSecretPlaceholders(value: string): string {
  return value.replace(daytonaSecretPlaceholderPattern, "[secret placeholder redacted]");
}

export function containsDaytonaSecretPlaceholder(value: unknown): boolean {
  if (typeof value === "string") {
    daytonaSecretPlaceholderPattern.lastIndex = 0;
    return daytonaSecretPlaceholderPattern.test(value);
  }
  if (value instanceof Uint8Array) {
    return containsDaytonaSecretPlaceholder(Buffer.from(value).toString("utf8"));
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? containsDaytonaSecretPlaceholder(serialized)
      : false;
  } catch {
    return true;
  }
}

export function assertNoDaytonaSecretPlaceholders(
  value: unknown,
  destination: string,
): void {
  if (containsDaytonaSecretPlaceholder(value)) {
    throw new Error(`${destination} cannot contain a workspace secret placeholder`);
  }
}

export function workspaceSecretUsageInstructions(
  secrets: ReadonlyArray<{
    environmentVariable: string;
    allowedHosts: string[];
  }>,
  promptParts?: InvestigationPromptParts,
): string | null {
  if (secrets.length === 0) return null;
  const prompt = (key: string, values: Record<string, string> = {}) =>
    renderInvestigationPromptPart(key, promptParts, values);
  return [
    prompt("secretHeader"),
    ...secrets.map((secret) => prompt("secretEntry", {
      environmentVariable: secret.environmentVariable,
      allowedHosts: secret.allowedHosts.join(", "),
    })),
    prompt("secretUsage"),
    prompt("secretSafety"),
  ].filter(Boolean).join("\n");
}

const connectionSecretFields = new Set([
  "accessKey",
  "accessToken",
  "apiKey",
  "applicationKey",
  "externalId",
  "publicKey",
  "secretKey",
  "serviceAccountToken",
  "userAccessToken",
]);

// Shorter values are too likely to match ordinary text.
const minimumSecretLength = 8;

/**
 * Collects the credentials held by runtime connections, including query
 * parameter values in configured MCP URLs, so provider errors can be shown
 * and logged without them.
 */
export function connectionSecrets(
  connections: ReadonlyArray<object | null | undefined>,
): string[] {
  const secrets = new Set<string>();
  for (const connection of connections) {
    if (!connection) continue;
    for (const [field, value] of Object.entries(connection)) {
      if (typeof value !== "string") continue;
      if (connectionSecretFields.has(field)) secrets.add(value);
      if (field === "mcpUrl" && URL.canParse(value)) {
        for (const parameter of new URL(value).searchParams.values()) {
          secrets.add(parameter);
        }
      }
    }
  }
  return [...secrets].filter((secret) => secret.length >= minimumSecretLength);
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  // Replace longer values first so one secret containing another is fully removed.
  return [...secrets]
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
}
