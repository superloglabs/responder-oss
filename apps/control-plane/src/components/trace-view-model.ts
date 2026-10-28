import type { Span, WaterfallRow } from "../telemetry-api";

const servicePalette = ["#3b8ff5", "#8b50f5", "#df762c", "#36aa9c", "#cf5595", "#8d9637"];

// Assign once from the complete waterfall so filtering never changes a service's color.
export function traceServiceColors(rows: WaterfallRow[]): Map<string, string> {
  return new Map([...new Set(rows.map(({ span }) => span.service))].map((service, index) => [service, servicePalette[index % servicePalette.length]!]));
}

export function visibleTraceRows(rows: WaterfallRow[], collapsed: ReadonlySet<string>, search: string, errorsOnly = false): WaterfallRow[] {
  const query = search.trim().toLowerCase();
  const filtering = Boolean(query) || errorsOnly;
  if (filtering) {
    // Keep ancestors of matches for context, even inside a collapsed branch.
    const keep = new Set<string>();
    const ancestors: WaterfallRow[] = [];
    for (const row of rows) {
      while (ancestors.length && ancestors.at(-1)!.depth >= row.depth) ancestors.pop();
      const { span } = row;
      const matches = !query || [span.span_name, span.service, span.span_id,
        ...Object.entries(span.span_attrs).flat(), ...Object.entries(span.resource_attrs).flat(),
      ].some((value) => value.toLowerCase().includes(query));
      if (matches && (!errorsOnly || span.status_code === "STATUS_CODE_ERROR")) {
        keep.add(span.span_id);
        for (const ancestor of ancestors) keep.add(ancestor.span.span_id);
      }
      ancestors.push(row);
    }
    return rows.filter(({ span }) => keep.has(span.span_id));
  }
  let hiddenBelow: number | null = null;
  return rows.filter((row) => {
    if (hiddenBelow !== null && row.depth > hiddenBelow) return false;
    hiddenBelow = collapsed.has(row.span.span_id) ? row.depth : null;
    return true;
  });
}

export function traceRequest(span: Span): { method: string; name: string; status: number | null } {
  const attrs = span.span_attrs;
  const method = attrs["http.request.method"] || attrs["http.method"] || "";
  let path = attrs["http.route"] || attrs["url.path"] || "";
  if (!path && (attrs["url.full"] || attrs["http.url"])) {
    try { path = new URL(attrs["url.full"] || attrs["http.url"]!).pathname; } catch { /* Keep the span name for malformed URLs. */ }
  }
  const status = Number(attrs["http.response.status_code"] || attrs["http.status_code"]);
  return {
    method,
    name: method && path ? path : span.span_name === method ? span.span_name : method && span.span_name.startsWith(`${method} `) ? span.span_name.slice(method.length + 1) : span.span_name,
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  };
}

export function traceAttributeScopes(span: Span) {
  const http: Record<string, string> = {};
  const context: Record<string, string> = {};
  for (const [key, value] of Object.entries(span.span_attrs)) {
    (/^(http\.|url\.|server\.)/.test(key) ? http : context)[key] = value;
  }
  return [
    { id: "http", label: "HTTP", heading: "HTTP", prefix: "span.", values: http },
    { id: "context", label: "Request context", heading: "Request context", prefix: "span.", values: context, defaultCollapsed: Object.keys(http).length > 0 },
    { id: "resource", label: "Resource", heading: "Resource attributes", prefix: "resource.", values: span.resource_attrs, defaultCollapsed: true },
  ];
}
