// OTLP over HTTP in its JSON encoding, for the telemetry that cloud providers
// deliver in their own formats. Trace and span IDs are lowercase hex strings
// and 64-bit integers are decimal strings, as the encoding requires.

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpLogRecord = {
  attributes: OtlpKeyValue[];
  body: OtlpAnyValue;
  flags?: number;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  spanId?: string;
  timeUnixNano: string;
  traceId?: string;
};

export type OtlpLogsRequest = {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{ logRecords: OtlpLogRecord[]; scope: { name: string } }>;
  }>;
};

// An attribute, or null for an empty value. Objects and arrays are kept as
// JSON text.
export function attribute(key: string, value: unknown): OtlpKeyValue | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: jsonText(value) } };
}

export function attributes(...values: Array<OtlpKeyValue | null>): OtlpKeyValue[] {
  return values.filter((value): value is OtlpKeyValue => value !== null);
}

// One attribute per field of an object, named prefix.field.
export function prefixedAttributes(prefix: string, value: unknown): OtlpKeyValue[] {
  return attributes(...Object.entries(objectOrEmpty(value)).map(([key, item]) => attribute(`${prefix}.${key}`, item)));
}

export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? "";
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// A hex ID of the given length, lowercased, or undefined.
export function hexId(value: unknown, length: 16 | 32): string | undefined {
  return typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${length}}$`, "u").test(value)
    ? value.toLowerCase()
    : undefined;
}

export function millisToNanos(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(BigInt(Math.trunc(value)) * 1_000_000n);
  if (typeof value === "string" && /^\d+$/u.test(value)) return String(BigInt(value) * 1_000_000n);
  return "0";
}

// An RFC 3339 time in nanoseconds, keeping a fraction of up to nine digits.
export function rfc3339ToNanos(value: unknown): string {
  if (typeof value !== "string") return "0";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match?.[1]) return "0";
  const millis = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(millis)) return "0";
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return String(BigInt(Math.trunc(millis / 1000)) * 1_000_000_000n + BigInt(fraction));
}
