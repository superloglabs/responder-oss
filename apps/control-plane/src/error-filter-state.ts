import { errorIssueStatusLabels } from "./error-issues-api";

export const filterProperties = ["status", "activity", "service", "environment"] as const;
export type FilterProperty = typeof filterProperties[number];
export type ErrorFilters = Record<FilterProperty, string[]>;

export function readErrorFilters(params: URLSearchParams): ErrorFilters {
  const status = params.has("status") ? params.getAll("status").filter((value) => Object.hasOwn(errorIssueStatusLabels, value)) : ["open"];
  return {
    status,
    activity: params.getAll("activity").filter((value) => value === "active" || value === "inactive"),
    service: params.getAll("service"), environment: params.getAll("environment"),
  };
}

