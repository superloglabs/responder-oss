import { useCallback, type ReactNode } from "react";
import { fetchRenderLogReading, readRenderResource } from "../telemetry-sources-api";
import { LogReading, type LogReadingParts } from "./log-reading";

// The Render services and workspaces whose logs Superlog reads with one API
// key. Errors in those logs become error issues, which alert people and
// start Signal.

const labels = {
  add: "Add service",
  empty: "This key reaches no running services",
  list: "Render services whose logs Superlog reads",
  loadFailed: "Could not load Render services.",
  menu: "Render services and workspaces",
};

function useRenderReading(integrationAccountId: string) {
  const load = useCallback(async () => {
    const reading = await fetchRenderLogReading(integrationAccountId);
    return reading && {
      // A workspace comes first, followed by its services.
      options: reading.readables.map((readable) => ({
        label: readable.kind === "workspace"
          ? `${readable.workspaceName} · All services`
          : `${readable.workspaceName} · ${readable.serviceName ?? readable.id}`,
        value: readable.id,
      })),
      sources: reading.sources,
    };
  }, [integrationAccountId]);
  const add = useCallback(
    (resourceId: string) => readRenderResource(integrationAccountId, resourceId),
    [integrationAccountId],
  );
  return { add, labels, load };
}

export function RenderLogReading({ integrationAccountId, children }: {
  children: (parts: LogReadingParts) => ReactNode;
  integrationAccountId: string;
}) {
  return <LogReading {...useRenderReading(integrationAccountId)}>{children}</LogReading>;
}
