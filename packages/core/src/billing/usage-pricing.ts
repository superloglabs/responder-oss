// Prices metered usage for billing. A hosted edition may replace this file
// with its own rates. This default charges Responder-funded model usage at
// provider cost and does not charge for sandbox time.

export interface SandboxResources {
  cpu: number;
  diskGiB: number;
  memoryGiB: number;
}

// The amount charged for a Responder-funded model request, in micro-dollars.
export function inferenceChargeMicros(providerCostMicros: number): number {
  return providerCostMicros;
}

// The amount charged for a sandbox that ran for `seconds`, in micro-dollars.
export function sandboxChargeMicros(
  resources: SandboxResources,
  seconds: number,
): number {
  void resources;
  void seconds;
  return 0;
}
