import { useEffect, useState } from "react";

export type GcpSetupStep =
  | "starting"
  | "enabling_apis"
  | "creating_identity_pool"
  | "creating_identity_provider"
  | "granting_access"
  | "waiting_for_google";

export interface GcpSetupStatus {
  message?: string;
  status: "failed" | "running" | "succeeded";
  step: GcpSetupStep;
  updatedAt: string;
}

export const GCP_SETUP_STEPS: Array<{
  id: GcpSetupStep;
  label: string;
  progress: string;
}> = [
  { id: "starting", label: "Check your access", progress: "Checking your access…" },
  { id: "enabling_apis", label: "Enable Google Cloud APIs", progress: "Enabling Google Cloud APIs…" },
  { id: "creating_identity_pool", label: "Create the identity pool", progress: "Creating the identity pool…" },
  { id: "creating_identity_provider", label: "Link the pool to Responder", progress: "Linking the pool to Responder…" },
  { id: "granting_access", label: "Grant read-only roles", progress: "Granting read-only roles…" },
  { id: "waiting_for_google", label: "Wait for Google to apply access", progress: "Waiting for Google to apply access…" },
];

const POLL_INTERVAL_MS = 2_500;

export function gcpSetupProgressLabel(setup: GcpSetupStatus): string {
  if (setup.status === "succeeded") return "Connected";
  if (setup.status === "failed") return setup.message ?? "Setup failed";
  return GCP_SETUP_STEPS.find((step) => step.id === setup.step)?.progress ??
    "Setting up…";
}

/** Polls a running setup until it succeeds or fails. */
export function useGcpSetupStatus(
  accountId: string | null,
  initial: GcpSetupStatus | null,
): GcpSetupStatus | null {
  const [polled, setPolled] = useState<{
    accountId: string;
    setup: GcpSetupStatus;
  } | null>(null);
  const setup = polled && polled.accountId === accountId ? polled.setup : initial;
  const running = setup?.status === "running";

  useEffect(() => {
    if (!accountId || !running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetch(`/api/integrations/gcp/${accountId}/setup`)
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json().catch(() => null)) as GcpSetupStatus | null;
          if (!cancelled && body?.status) setPolled({ accountId, setup: body });
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accountId, running]);

  return setup;
}
