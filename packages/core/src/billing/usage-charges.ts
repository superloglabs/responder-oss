import {
  inferenceChargeMicros,
  sandboxChargeMicros,
  type SandboxResources,
} from "./usage-pricing.js";

// Whole micro-dollars, rounded up, ignoring floating-point noise.
function wholeMicros(value: number): number {
  return Math.max(0, Math.ceil(value - 1e-6));
}

export function inferenceCharge(providerCostMicros: number): number {
  return wholeMicros(inferenceChargeMicros(providerCostMicros));
}

export function sandboxCharge(resources: SandboxResources, seconds: number): number {
  return wholeMicros(sandboxChargeMicros(resources, seconds));
}

// Sandbox time is billed when the edition gives it a price.
export function sandboxTimeIsBilled(): boolean {
  return sandboxCharge({ cpu: 1, diskGiB: 1, memoryGiB: 1 }, 3_600) > 0;
}
