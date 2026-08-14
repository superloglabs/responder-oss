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
    return Buffer.from(value).includes(Buffer.from("dtn_secret_"));
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? containsDaytonaSecretPlaceholder(serialized)
      : false;
  } catch {
    return false;
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
