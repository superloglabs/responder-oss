import { originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";
import { enclosingFunctionName } from "./enclosing-function.js";
import { MAXIMUM_FRAME_LINE_LENGTH, MAXIMUM_STACK_LINES } from "./fingerprint.js";
import type { ErrorCandidate } from "./error-issues.js";

// Maps minified browser frames back to the original source before errors
// are grouped, so an issue keeps its fingerprint across builds and shows the
// code that failed. The browser SDK sends `app.debug_ids`, the debug ID of
// each file in the stack by URL, and the build uploaded each file's map under
// that ID.

export const debugIdsAttribute = "app.debug_ids";
// The stack as the browser reported it, kept on the sample.
export const minifiedStacktraceAttribute = "exception.stacktrace.minified";
// The components that rendered the failing one, which @superlog/react
// attaches in the same frame format as the stack.
export const componentStackAttribute = "react.component_stack";
export const minifiedComponentStackAttribute = "react.component_stack.minified";

// Loads a workspace's maps, as JSON text by debug ID.
export type SourceMapLoader = (organizationId: string, debugIds: string[]) => Promise<Map<string, string>>;

type StackLine = {
  column: number;
  fn: string | null;
  line: number;
  // Text before the frame, such as Firefox's `async*`.
  marker: string;
  style: "v8" | "gecko";
  url: string;
};

const V8_BARE = /^(\s*at\s+)(?:address at )?(\S+?):(\d+):(\d+)$/;
const GECKO = /^(\s*)((?:[^@*\s][^@*]*\*)?)([^@]*)@(\S+?):(\d+):(\d+)$/;

// `at fn (url:line:col)` without a regular expression, which would take time
// cubic in the line's length. The URL has no whitespace, so the `(` before it
// follows the line's last whitespace, or the frame reads `(address at url`.
function v8WithFunction(text: string): StackLine | null {
  const marker = /^\s*at\s+/.exec(text)?.[0];
  if (!marker || !text.endsWith(")")) return null;
  const lastWhitespace = text.search(/\s\S*$/);
  const openings = [lastWhitespace - 11, lastWhitespace + 1];
  for (const open of openings) {
    const address = open === lastWhitespace - 11;
    if (open <= marker.length || text[open] !== "(" || (address && !text.startsWith("(address at ", open))) continue;
    let fnEnd = open;
    while (fnEnd > marker.length && /\s/.test(text[fnEnd - 1]!)) fnEnd -= 1;
    if (fnEnd === open || fnEnd === marker.length) continue;
    const location = /:(\d+):(\d+)\)$/.exec(text);
    const urlStart = open + (address ? 12 : 1);
    if (!location || location.index <= urlStart) continue;
    return {
      column: Number(location[2]),
      fn: text.slice(marker.length, fnEnd),
      line: Number(location[1]),
      marker,
      style: "v8",
      url: text.slice(urlStart, location.index),
    };
  }
  return null;
}

function parseLine(text: string): StackLine | null {
  // Longer lines are not frames, which bounds the work for any stack.
  if (text.length > MAXIMUM_FRAME_LINE_LENGTH) return null;
  const withFunction = v8WithFunction(text);
  if (withFunction) return withFunction;
  const bare = text.match(V8_BARE);
  if (bare) return { column: Number(bare[4]), fn: null, line: Number(bare[3]), marker: bare[1]!, style: "v8", url: bare[2]! };
  const gecko = text.match(GECKO);
  if (gecko) {
    return { column: Number(gecko[6]), fn: gecko[3] || null, line: Number(gecko[5]), marker: `${gecko[1]}${gecko[2]}`, style: "gecko", url: gecko[4]! };
  }
  return null;
}

// Map sources are written relative to the map or with a bundler scheme, such
// as `../../src/cart.ts` or `webpack://app/./src/cart.ts`.
export function cleanSourcePath(source: string): string {
  return source
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, "")
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/^\/+/, "");
}

function format(line: StackLine, fn: string | null, source: string, row: number, column: number): string {
  if (line.style === "gecko") return `${line.marker}${fn ?? ""}@${source}:${row}:${column}`;
  return fn ? `${line.marker}${fn} (${source}:${row}:${column})` : `${line.marker}${source}:${row}:${column}`;
}

const lineStarts = new WeakMap<TraceMap, Map<string, number[]>>();

// The function around an original position, read from the source the map
// embeds. Undefined when the map has no source for it.
function functionAt(map: TraceMap, source: string, line: number, column: number): string | null | undefined {
  const content = sourceContentFor(map, source);
  if (content === null || content === undefined) return undefined;
  const bySource = lineStarts.get(map) ?? new Map<string, number[]>();
  lineStarts.set(map, bySource);
  let starts = bySource.get(source);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") starts.push(i + 1);
    bySource.set(source, starts);
  }
  const start = starts[line - 1];
  return start === undefined ? null : enclosingFunctionName(content, start + column);
}

// Rewrites each frame whose file has a map. A frame is named by the function
// around its original position, read from the source the map embeds; this
// holds when a browser leaves out frames, as Safari does for tail calls.
// Without the source, it is named by the identifier its caller called. A
// frame with neither keeps no function name and groups by its file alone.
export function symbolicateStack(stacktrace: string, debugIds: Record<string, string>, maps: Map<string, TraceMap>): string | null {
  const lines = stacktrace.split("\n");
  // Lines past the limit stay as they are.
  const parsed = lines.slice(0, MAXIMUM_STACK_LINES).map(parseLine);
  const positions = parsed.map((frame) => {
    if (!frame) return null;
    const debugId = debugIds[frame.url];
    const map = debugId ? maps.get(debugId) : undefined;
    if (!map) return null;
    const position = originalPositionFor(map, { column: Math.max(0, frame.column - 1), line: frame.line });
    return position.source && position.line !== null ? { ...position, map } : null;
  });
  if (!positions.some(Boolean)) return null;
  return lines
    .map((text, index) => {
      const frame = parsed[index];
      const position = positions[index];
      if (!frame || !position) return text;
      let fn = functionAt(position.map, position.source!, position.line!, position.column ?? 0);
      if (fn === undefined) {
        // Stacks list the innermost frame first, so the caller is next.
        const callerIndex = parsed.findIndex((other, otherIndex) => otherIndex > index && other !== null);
        fn = (callerIndex === -1 ? null : positions[callerIndex]?.name) ?? null;
      }
      return format(frame, fn, cleanSourcePath(position.source!), position.line!, (position.column ?? 0) + 1);
    })
    .join("\n");
}

function debugIdsOf(candidate: ErrorCandidate): Record<string, string> | null {
  const raw = candidate.attrs?.[debugIdsAttribute];
  if (!raw || (!candidate.exception_stacktrace && !candidate.attrs[componentStackAttribute])) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const ids = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[0-9a-f-]{36}$/i.test(entry[1])),
    );
    return Object.keys(ids).length ? ids : null;
  } catch {
    return null;
  }
}

// Parsed maps kept between passes, so a burst of one error does not parse
// its map again every pass. A debug ID names one build of one file, so a
// cached map does not go stale.
const parsedMapLimit = 50;
const parsedMaps = new Map<string, TraceMap>();

function remember(key: string, map: TraceMap): void {
  parsedMaps.delete(key);
  parsedMaps.set(key, map);
  while (parsedMaps.size > parsedMapLimit) parsedMaps.delete(parsedMaps.keys().next().value!);
}

// Symbolicates the candidates that carry debug IDs. A map that fails to
// parse leaves its frames as they were.
export async function symbolicateCandidates(candidates: ErrorCandidate[], load: SourceMapLoader): Promise<ErrorCandidate[]> {
  const wanted = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const ids = debugIdsOf(candidate);
    if (!ids) continue;
    const set = wanted.get(candidate.project_id) ?? new Set<string>();
    for (const id of Object.values(ids)) set.add(id.toLowerCase());
    wanted.set(candidate.project_id, set);
  }
  if (wanted.size === 0) return candidates;

  const maps = new Map<string, Map<string, TraceMap>>();
  for (const [organizationId, ids] of wanted) {
    const parsed = new Map<string, TraceMap>();
    const missing: string[] = [];
    for (const id of ids) {
      const cached = parsedMaps.get(`${organizationId}:${id}`);
      if (cached) parsed.set(id, cached);
      else missing.push(id);
    }
    for (const [debugId, json] of missing.length ? await load(organizationId, missing) : []) {
      try {
        const map = new TraceMap(json);
        parsed.set(debugId.toLowerCase(), map);
        remember(`${organizationId}:${debugId.toLowerCase()}`, map);
      } catch {
        // A broken map symbolicates nothing.
      }
    }
    maps.set(organizationId, parsed);
  }

  return candidates.map((candidate) => {
    const ids = debugIdsOf(candidate);
    const workspaceMaps = maps.get(candidate.project_id);
    if (!ids || !workspaceMaps || workspaceMaps.size === 0) return candidate;
    const lowered = Object.fromEntries(Object.entries(ids).map(([url, id]) => [url, id.toLowerCase()]));
    const symbolicated = symbolicateStack(candidate.exception_stacktrace, lowered, workspaceMaps);
    const componentStack = candidate.attrs[componentStackAttribute];
    const components = componentStack ? symbolicateStack(componentStack, lowered, workspaceMaps) : null;
    if (!symbolicated && !components) return candidate;
    return {
      ...candidate,
      attrs: {
        ...candidate.attrs,
        ...(symbolicated ? { [minifiedStacktraceAttribute]: candidate.exception_stacktrace } : {}),
        ...(components ? { [componentStackAttribute]: components, [minifiedComponentStackAttribute]: componentStack! } : {}),
      },
      exception_stacktrace: symbolicated ?? candidate.exception_stacktrace,
    };
  });
}
