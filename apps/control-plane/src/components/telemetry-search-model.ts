import { explorerFilterText, type ExplorerFilter, type LogExplorerQuery, type TraceSearchQuery } from "../telemetry-api";

export type SearchOperator = "=" | "!=" | ">=" | "contains";
export interface SearchField {
  key: string;
  label: string;
  group: string;
  aliases?: string[];
  operators: SearchOperator[];
  kind?: "duration" | "trace" | "message";
}
export interface SearchToken { id: string; key: string; op: SearchOperator; value: string }
export type SearchQuery = LogExplorerQuery | TraceSearchQuery;
export const traceIdPattern = /^[a-f0-9]{32}$/iu;
export const statusLabels: Record<string, string> = { STATUS_CODE_ERROR: "Error", STATUS_CODE_OK: "OK", STATUS_CODE_UNSET: "Unset" };
export const fieldLabel = (key: string) => key.replace(/^(resource|log|span|field)\./u, "");

export function searchFields(signal: "logs" | "traces", keys: string[]): SearchField[] {
  const fields: SearchField[] = [
    { key: "service", label: "service.name", group: "Resource attributes", aliases: ["service", "resource.service.name"], operators: ["="] },
    ...(signal === "logs" ? [
      { key: "severity", label: "level", group: "Log attributes", aliases: ["severity"], operators: ["="] } as SearchField,
    ] : [
      { key: "status", label: "status", group: "Trace attributes", operators: ["="] } as SearchField,
      { key: "operation", label: "operation", aliases: ["span", "span.name"], group: "Trace attributes", operators: ["="] } as SearchField,
      { key: "duration", label: "duration", group: "Trace attributes", operators: [">="], kind: "duration" } as SearchField,
    ]),
    { key: "field.trace_id", label: "trace.id", aliases: ["trace_id"], group: signal === "logs" ? "Log attributes" : "Trace attributes", operators: ["=", "!="], kind: "trace" },
  ];
  for (const key of [...new Set(keys)].sort()) {
    if (key === "resource.service.name" || fields.some(f => f.key === key)) continue;
    fields.push({ key, label: fieldLabel(key), group: key.startsWith("resource.") ? "Resource attributes" : key.startsWith("log.") ? "Log attributes" : key.startsWith("span.") ? "Span attributes" : "Fields", operators: ["=", "!="] });
  }
  return fields.sort((a, b) => a.group === b.group ? 0 : a.group === "Resource attributes" ? -1 : b.group === "Resource attributes" ? 1 : a.group.localeCompare(b.group));
}

export function searchTokens(query: SearchQuery): SearchToken[] {
  return [
    ...query.services.map(value => ({ id: `service:${value}`, key: "service", op: "=" as const, value })),
    ...("search" in query ? [
      ...query.severities.map(value => ({ id: `severity:${value}`, key: "severity", op: "=" as const, value })),
      ...(query.search ? [{ id: "message", key: "message", op: "contains" as const, value: query.search }] : []),
    ] : [
      ...query.operations.map(value => ({ id: `operation:${value}`, key: "operation", op: "=" as const, value })),
      ...query.statuses.map(value => ({ id: `status:${value}`, key: "status", op: "=" as const, value })),
      ...(query.minDurationMs > 0 ? [{ id: "duration", key: "duration", op: ">=" as const, value: `${query.minDurationMs}ms` }] : []),
    ]),
    ...query.filters.map(filter => ({ id: `filter:${explorerFilterText(filter)}`, key: filter.key, op: filter.op === "neq" ? "!=" as const : "=" as const, value: filter.value })),
  ];
}

export function durationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/u.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2]] ?? 1);
  return ms > 0 && ms <= 3_600_000 ? ms : null;
}

// Rebuild in one update, so editing a chip cannot race its removal against addition.
// Preserve the time range and expanded sidebar facets. Equality values for a
// single facet retain the API's OR semantics; distinct facets are ANDed.
export function queryWithTokens<T extends SearchQuery>(query: T, tokens: SearchToken[]): T {
  const values = (key: string) => [...new Set(tokens.filter(t => t.key === key).map(t => t.value))];
  const primary = new Set(["service", "severity", "operation", "status", "duration", "message"]);
  const filters: ExplorerFilter[] = tokens.filter(t => !primary.has(t.key)).map(t => ({ key: t.key, op: t.op === "!=" ? "neq" : "eq", value: t.value }));
  const uniqueFilters = filters.filter((f, i) => filters.findIndex(other => explorerFilterText(f) === explorerFilterText(other)) === i);
  return { ...query, services: values("service"), filters: uniqueFilters,
    ...("search" in query ? { severities: values("severity").map(value => value.toUpperCase()), search: values("message").at(-1) ?? "" } : {
      operations: values("operation"), statuses: values("status"), minDurationMs: durationMs(values("duration").at(-1) ?? "") ?? 0,
    }),
  };
}

export function parseSearchDraft(text: string, fields: SearchField[]): { field: SearchField; op: SearchOperator; value: string } | null {
  const match = /^([\w.-]+)\s*(!=|>=|=|>|<|<=|:)\s*(.*)$/su.exec(text.trim());
  if (!match) return null;
  const known = fields.find(f => [f.key, f.label, ...(f.aliases ?? [])].includes(match[1]));
  // Discovery is sampled. A valid attribute can be absent from its suggestions.
  const key = /^(resource|log|span|field)\./u.test(match[1]) ? match[1] : `resource.${match[1]}`;
  const field: SearchField = known ?? { key, label: fieldLabel(key), group: key.startsWith("resource.") ? "Resource attributes" : "Attributes", operators: ["=", "!="] };
  const op = match[2] === ":" ? "=" : match[2];
  // Do not silently interpret an unsupported comparison as a different one.
  if (!field || !field.operators.includes(op as SearchOperator)) return null;
  return { field, op: op as SearchOperator, value: match[3].replace(/^"(.*)"$/su, "$1") };
}
