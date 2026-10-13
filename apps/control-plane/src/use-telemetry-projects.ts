import { useEffect, useState } from "react";
import { fetchTelemetryProjects, type TelemetryProject } from "./telemetry-api";

// Undefined while loading; null when the workspace cannot read telemetry.
type ProjectsState = TelemetryProject[] | null | undefined;

export type TelemetryProjectsState = ReturnType<typeof useTelemetryProjects>;

export function useTelemetryProjects() {
  const [projects, setProjects] = useState<ProjectsState>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTelemetryProjects()
      .then((loaded) => {
        if (cancelled) return;
        setProjects(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load telemetry projects");
        }
      });
    return () => { cancelled = true; };
  }, [attempt]);

  return {
    error,
    projects,
    retry: () => {
      setError(null);
      setAttempt((current) => current + 1);
    },
  };
}
