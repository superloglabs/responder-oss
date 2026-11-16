import { useCallback, type ReactNode } from "react";
import { fetchPostHogLogReading, readPostHogProject } from "../telemetry-sources-api";
import { LogReading, LogReadingRow, type LogReadingParts } from "./log-reading";

// The PostHog projects whose error logs Superlog reads for one connection.
// Those lines become error issues, which alert people and start Signal.

const labels = {
  add: "Add project",
  empty: "This connection reads no projects",
  list: "PostHog projects whose logs Superlog reads",
  loadFailed: "Could not load PostHog projects.",
  menu: "PostHog projects",
};

function usePostHogReading(integrationAccountId: string) {
  const load = useCallback(async () => {
    const reading = await fetchPostHogLogReading(integrationAccountId);
    return reading && {
      options: reading.projects.map((project) => ({
        label: project.organizationName ? `${project.organizationName} · ${project.name}` : project.name,
        value: project.id,
      })),
      sources: reading.sources,
    };
  }, [integrationAccountId]);
  const add = useCallback(
    (projectId: string) => readPostHogProject(integrationAccountId, projectId),
    [integrationAccountId],
  );
  return { add, labels, load };
}

export function PostHogLogReading({ integrationAccountId, children }: {
  children: (parts: LogReadingParts) => ReactNode;
  integrationAccountId: string;
}) {
  return <LogReading {...usePostHogReading(integrationAccountId)}>{children}</LogReading>;
}

// For places without a details table, such as the Settings PostHog card.
export function PostHogLogReadingSettings({ integrationAccountId }: { integrationAccountId: string }) {
  return <LogReadingRow {...usePostHogReading(integrationAccountId)} />;
}
