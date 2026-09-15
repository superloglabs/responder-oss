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
