import type { SignalCooldownHours, SignalSeverity } from "./model";

export const severityOptions: Array<{ value: SignalSeverity; label: string }> = [
  { value: "SEV-1", label: "SEV-1" },
  { value: "SEV-2", label: "SEV-2 and up" },
  { value: "SEV-3", label: "All" },
];

export const cooldownOptions: Array<{ value: SignalCooldownHours; label: string }> = [
  { value: 6, label: "After 6 hours" },
  { value: 24, label: "After 1 day" },
  { value: 72, label: "After 3 days" },
  { value: 168, label: "After 7 days" },
];

const capPresets = [10, 25, 50, 100, 200];

// Daily caps to choose from: the presets up to the most allowed, the most
// allowed itself, and a stored cap that is not a preset.
export function capOptions(max: number, current: number | null) {
  const values = new Set([...capPresets.filter((value) => value <= max), max]);
  if (current !== null && current <= max) values.add(current);
  return [...values].sort((a, b) => a - b);
}

export const maxSkippedServices = 50;
const skippedServicePattern = /^[A-Za-z0-9._:/-]+\*?$/u;

// Why a service name cannot be skipped, or null when it can.
export function skippedServiceError(value: string, existing: readonly string[]) {
  if (!value) return "Enter a service name.";
  if (value.length > 200) return "Use 200 characters or fewer.";
  if (!skippedServicePattern.test(value)) return "Use letters, numbers, and . _ : / -, with an optional * at the end.";
  if (existing.includes(value)) return `${value} is already skipped.`;
  if (existing.length >= maxSkippedServices) return `Signal can skip up to ${maxSkippedServices} services.`;
  return null;
}
