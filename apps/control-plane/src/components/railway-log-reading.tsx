import { useCallback, type ReactNode } from "react";
import { fetchRailwayLogReading, readRailwayEnvironment } from "../telemetry-sources-api";
import { LogReading, LogReadingRow, type LogReadingParts } from "./log-reading";

// The Railway environments whose logs Superlog reads for one connection.
// Errors in those logs become error issues, which alert people and start
// Signal.

const labels = {
  add: "Add environment",
  empty: "This connection shares no environments",
  list: "Railway environments whose logs Superlog reads",
  loadFailed: "Could not load Railway environments.",
  menu: "Railway environments",
};

function useRailwayReading(integrationAccountId: string) {
  const load = useCallback(async () => {
    const reading = await fetchRailwayLogReading(integrationAccountId);
    return reading && {
      options: reading.environments.map((environment) => ({
        label: `${environment.projectName} · ${environment.environmentName}`,
        value: environment.environmentId,
      })),
      sources: reading.sources,
    };
  }, [integrationAccountId]);
  const add = useCallback(
    (environmentId: string) => readRailwayEnvironment(integrationAccountId, environmentId),
    [integrationAccountId],
  );
  return { add, labels, load };
}

export function RailwayLogReading({ integrationAccountId, children }: {
  children: (parts: LogReadingParts) => ReactNode;
  integrationAccountId: string;
}) {
  return <LogReading {...useRailwayReading(integrationAccountId)}>{children}</LogReading>;
}

// For places without a details table, such as the Settings Railway card.
export function RailwayLogReadingSettings({ integrationAccountId }: { integrationAccountId: string }) {
  return <LogReadingRow {...useRailwayReading(integrationAccountId)} />;
}
