import { createHash } from "node:crypto";

// Groups error occurrences into issues. Equal fingerprints are the same
// problem: the exception type and the top frames of the application's own
// code. The message, with per-occurrence values replaced, takes the frames'
// place when the stack has none of the application's code. A frame is its
// function and file: no line numbers, URL origins or bundle hashes, so the
// same code groups across browsers, builds, and hosts.
//
// Every fingerprint starts with the algorithm version. A change that alters
// any hash must bump it and keep the previous algorithm, as fingerprint-v1.ts
// keeps v1, so existing issues move to the new fingerprint instead of opening
// again as new.
export const fingerprintVersion = "v2";

export type Fingerprint = {
  hash: string;
  exceptionType: string;
  topFrame: string | null;
  normalizedFrames: string[];
};

export type LogFingerprintInput = {
  service: string;
  severity: string;
  body: string;
  exceptionType?: string | null;
  // The exception's message, grouped like a span's when the log has a stack.
  message?: string | null;
  stacktrace?: string | null;
};

type Frame = { fn: string | null; path: string };

const TOP_N_FRAMES = 5;
const HASH_LEN = 16;

const IGNORE_PATH = [
  /node_modules\//,
  /^node:internal\//,
  /^node:async_hooks/,
  /async_hooks\.js/,
  /^webpack:\/\/\/(?:webpack\/|\(webpack\)\/)/,
  /(?:site|dist)-packages\//,
  /\/lib\/python\d+(?:\.\d+)*\//,
  /^<frozen /,
  // Browser extensions inject scripts into the page; their errors are not
  // the application's.
  /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//,
  // Libraries served from public CDNs, and Vite's development client.
  /^https?:\/\/(?:unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|esm\.run|esm\.sh)\//,
  /\/@vite\/client/,
  /\/@react-refresh/,
];

// Frames that carry no location: native code, eval, and anonymous scripts.
const LOW_QUALITY_PATHS = new Set([
  "<anonymous>",
  "[native code]",
  "native",
  "native code",
  "eval code",
  "debugger eval code",
  "unknown",
]);
const ANONYMOUS_FUNCTIONS = new Set(["?", "<anonymous>", "<anonymous function>", "anonymous", "Anonymous function"]);

const NUL_BYTE = String.fromCharCode(0);

// Postgres `text` and `jsonb` columns reject the NUL byte (0x00) with
// `22021 invalid byte sequence for encoding "UTF8": 0x00`. Telemetry can carry
// a raw NUL inside an exception message, body, or stack frame, and these
// fingerprint outputs flow straight into the issues upsert — so strip NUL
// before it can poison a parameter. Passes null/undefined through unchanged.
export function stripNullBytes<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? value.split(NUL_BYTE).join("") : value) as T;
}

export function fingerprint(input: {
  type: string;
  stacktrace: string | null | undefined;
  message?: string | null;
}): Fingerprint {
  const type = input.type || "Error";
  const frames = parseFrames(input.stacktrace ?? "");
  const userFrames = frames.filter(isUserFrame).slice(0, TOP_N_FRAMES);

  const picked = userFrames.length > 0 ? userFrames : frames.slice(0, TOP_N_FRAMES);
  const normalized = picked.map(formatFrame);
  // The application's frames say where an error comes from; its message
  // often carries per-occurrence values that no rule catches.
  const messageBucket = userFrames.length > 0 ? "" : messageBucketFor(input.message);
  const builtin = builtinGroup(type, input.message);
  const canonical = builtin ?? `${type}::${messageBucket}::${normalized.join("|")}`;
  const hash = hashCanonical(canonical);

  // The hash is hex (always safe); the human-readable fields below are persisted
  // to Postgres, so they must be NUL-free.
  const safeFrames = normalized.map((frame) => stripNullBytes(frame));
  return {
    hash,
    exceptionType: stripNullBytes(type),
    topFrame: safeFrames[0] ?? null,
    normalizedFrames: safeFrames,
  };
}

export function fingerprintLog(input: LogFingerprintInput): Fingerprint {
  if (input.stacktrace && input.stacktrace.trim().length > 0) {
    return fingerprint({
      message: input.message,
      type: input.exceptionType || input.severity || "LogError",
      stacktrace: input.stacktrace,
    });
  }

  // A Python traceback logged as the body groups like a span's exception.
  // Postgres driver errors keep their own grouping below.
  const traceback = extractPsycopgHeadline(input.body ?? "") ? null : pythonTracebackException(input.body ?? "");
  if (traceback) {
    return fingerprint({ message: traceback.message, stacktrace: input.body, type: traceback.type });
  }

  const type = input.exceptionType || input.severity || "LogError";
  const service = input.service || "unknown";
  const normalized = normalizeMessage(input.body ?? "");
  const canonical = `log::${service}::${type}::${normalized}`;
  const hash = hashCanonical(canonical);

  return {
    hash,
    exceptionType: stripNullBytes(type),
    topFrame: null,
    normalizedFrames: [],
  };
}

// The exception a Python traceback ends with: its last line that is not
// indented, as "Type: message" or a bare type.
export function pythonTracebackException(body: string): { message: string; type: string } | null {
  if (!body.includes("Traceback (most recent call last):")) return null;
  const lines = body.split("\n").map((line) => line.trimEnd());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][\w.]*)(?::\s*(.*))?$/);
    return match ? { message: match[2] ?? "", type: match[1]! } : null;
  }
  return null;
}

function hashCanonical(canonical: string): string {
  return `${fingerprintVersion}:${createHash("sha256").update(canonical).digest("hex").slice(0, HASH_LEN)}`;
}

// Browser errors that one cause produces from many places, grouped whatever
// their stack. A failed chunk load follows a deploy or a network drop; a
// hydration mismatch is one server and client difference.
const CHUNK_LOAD_MESSAGES = [
  /^ChunkLoadError/,
  /^Loading (?:CSS )?chunk [\w-]+ failed/,
  /^Failed to fetch dynamically imported module/,
  /^error loading dynamically imported module/,
  /^Importing a module script failed/,
  /^Unable to preload CSS/,
];
const HYDRATION_MESSAGES = [
  /^Hydration failed because/,
  /^Text content does not match server-rendered HTML/,
  /^There was an error while hydrating/,
  /^The server could not finish this Suspense boundary/,
  /^Minified React error #(?:418|419|422|423|425)[;. ]/,
];

function builtinGroup(type: string, message: string | null | undefined): string | null {
  const text = (message ?? "").trim();
  if (type === "ChunkLoadError" || CHUNK_LOAD_MESSAGES.some((re) => re.test(text))) return "builtin::chunk-load";
  if (HYDRATION_MESSAGES.some((re) => re.test(text))) return "builtin::hydration";
  return null;
}

// Bucket key for grouping by error message. Lighter than `normalizeMessage`:
// preserves alphabetic content (so `model is not supported` doesn't collapse
// onto `extra inputs are not permitted`) but strips identifiers that vary per
// occurrence. Anthropic-style envelopes are unwrapped first so the per-request
// `request_id` doesn't leak into the bucket.
const MESSAGE_BUCKET_MAX = 160;
export function messageBucketFor(message: string | null | undefined): string {
  if (!message) return "";
  let s = unwrapAnthropicErrorMessage(message);
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = collapseRequestPaths(s);
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/\b[A-Za-z0-9_]{20,}\b/g, "<id>");
  s = redactGeneratedIds(s);
  s = s.replace(/\b\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)\b/g, "<duration>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > MESSAGE_BUCKET_MAX ? s.slice(0, MESSAGE_BUCKET_MAX) : s;
}

// Replaces short generated values: hex strings and git SHAs, mixed letter
// and digit IDs, and dash-joined codes such as `CIR726-MA`. A value must
// switch between letters and digits often enough that words like `sha256`,
// `es2015`, and `gpt-4o` stay.
function redactGeneratedIds(s: string): string {
  return s.replace(/(?<![A-Za-z0-9])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9])/g, (token) => {
    if (token.includes("-")) {
      const joined = token.split("-").join("");
      if (isRandomId(joined) || isUppercaseCode(joined)) return "<id>";
      return token.split("-").map(redactGeneratedId).join("-");
    }
    return redactGeneratedId(token);
  });
}

function redactGeneratedId(token: string): string {
  if (isHexValue(token)) return "<hex>";
  return isRandomId(token) ? "<id>" : token;
}

function letterDigitRuns(token: string): number {
  return token.match(/\d+|[A-Za-z]+/g)?.length ?? 0;
}

function isHexValue(token: string): boolean {
  if (/^(?:[0-9a-f]{8,128}|[0-9A-F]{8,128})$/.test(token)) return true;
  const mixed = /\d/.test(token) && /[A-Fa-f]/.test(token);
  if (token.length === 7) return mixed && /^[0-9a-f]+$/.test(token);
  return token.length >= 4 && token.length <= 6 && mixed && /^(?:[0-9a-f]+|[0-9A-F]+)$/.test(token);
}

// Letters and digits that switch back and forth at least three times.
function isRandomId(token: string): boolean {
  if (token.length < 4 || letterDigitRuns(token) < 4) return false;
  return token.length >= 6 || (/[a-z]/.test(token) && /[A-Z]/.test(token));
}

// Uppercase codes such as order or customer numbers.
function isUppercaseCode(token: string): boolean {
  return token.length >= 6 && /^[A-Z0-9]+$/.test(token) && letterDigitRuns(token) >= 3;
}

// Collapse leading-slash request paths to a single `<path>` token. A route
// scanner hammering a server emits one error per probed URL (`/wp-admin`,
// `/.env`, `/.git/config`, …) that are otherwise identical — same type, same
// stacktrace. Without this every probed path becomes its own fingerprint, so a
// single bot sweep explodes into tens of thousands of distinct issues and
// floods ingestion. We only collapse a slash at a token boundary (start or
// after whitespace) so in-word slashes like `and/or` or `client/server` stay
// intact. The HTTP method (`GET`/`POST`) is left alone, so a sweep groups into
// at most a handful of issues (one per method) instead of thousands.
function collapseRequestPaths(s: string): string {
  return s.replace(/(^|\s)\/\S*/g, "$1<path>");
}

function unwrapAnthropicErrorMessage(raw: string): string {
  // SDK errors land as `<status> <json>`; pull `error.message` if present so we
  // hash the human-readable failure, not the JSON wrapper.
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m?.[1] ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : raw;
}

export function normalizeMessage(body: string): string {
  const vercelRuntimeRequest = normalizeVercelRuntimeRequest(body);
  if (vercelRuntimeRequest) return vercelRuntimeRequest;

  const psycopgError = normalizePsycopgError(body);
  if (psycopgError) return psycopgError;

  let s = body;
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = collapseRequestPaths(s);
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, "<str>");
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "<str>");
  s = s.replace(/\b[0-9a-f]{20,}\b/gi, "<hex>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

// Psycopg errors often arrive inside SQLAlchemy tracebacks or application log
// prefixes. Everything after the first driver-error line (DETAIL, rendered
// SQL, bound parameters) is occurrence metadata, not error identity.
function normalizePsycopgError(body: string): string | null {
  const headline = extractPsycopgHeadline(body);
  if (!headline) return null;

  let s = `postgres.errors.${headline.type}: ${headline.message}`;
  s = redactPostgresHeadlineValues(s);
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/\b[0-9a-f]{20,}\b/gi, "<hex>");
  s = s.replace(/\b\d+\b/g, "<n>");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

const PSYCOPG_ERROR_PREFIXES = ["psycopg2.errors.", "psycopg.errors."] as const;
const POSTGRES_IDENTIFIER_CONTEXTS = new Set([
  "column",
  "relation",
  "constraint",
  "table",
  "schema",
  "database",
  "index",
]);

export function extractPsycopgHeadline(body: string): { type: string; message: string } | null {
  let marker = -1;
  let prefix = "";
  for (const candidate of PSYCOPG_ERROR_PREFIXES) {
    const index = body.indexOf(candidate);
    if (index !== -1 && (marker === -1 || index < marker)) {
      marker = index;
      prefix = candidate;
    }
  }
  if (marker === -1) return null;

  const typeStart = marker + prefix.length;
  let cursor = typeStart;
  while (cursor < body.length && isIdentifierCharacter(body.charCodeAt(cursor))) cursor += 1;
  if (cursor === typeStart || (body[cursor] !== ":" && body[cursor] !== ")")) return null;

  const type = body.slice(typeStart, cursor);
  cursor += 1;
  while (body[cursor] === " " || body[cursor] === "\t") cursor += 1;
  const messageEnd = findPostgresDiagnosticBoundary(body, cursor);
  return { type, message: body.slice(cursor, messageEnd).trimEnd() };
}

function isIdentifierCharacter(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

function findPostgresDiagnosticBoundary(body: string, start: number): number {
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\r" || char === "\n") return index;
    if (char === "\\" && (body[index + 1] === "r" || body[index + 1] === "n")) return index;
    if (char !== " " && char !== "\t") continue;

    let marker = index;
    while (body[marker] === " " || body[marker] === "\t") marker += 1;
    if (isPostgresDiagnosticMarker(body, marker)) return index;
    index = marker - 1;
  }
  return body.length;
}

function isPostgresDiagnosticMarker(body: string, start: number): boolean {
  if (body.startsWith("(Background on this error at:", start)) return true;

  if (body[start] === "[") {
    let cursor = start + 1;
    const nameStart = cursor;
    while (isAsciiLetterCode(body.charCodeAt(cursor))) cursor += 1;
    return cursor > nameStart && body[cursor] === ":";
  }

  let cursor = start;
  if (!isUppercaseWordCharacter(body.charCodeAt(cursor))) return false;
  while (cursor < body.length) {
    while (isUppercaseWordCharacter(body.charCodeAt(cursor))) cursor += 1;
    if (body[cursor] === ":") return true;
    if (body[cursor] !== " ") return false;
    while (body[cursor] === " ") cursor += 1;

    if (isDigitCode(body.charCodeAt(cursor))) {
      while (isDigitCode(body.charCodeAt(cursor))) cursor += 1;
      while (body[cursor] === " ") cursor += 1;
      return body[cursor] === ":";
    }
    if (!isUppercaseWordCharacter(body.charCodeAt(cursor))) return false;
  }
  return false;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUppercaseWordCharacter(code: number): boolean {
  return (code >= 65 && code <= 90) || code === 95;
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function redactPostgresHeadlineValues(headline: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < headline.length) {
    const quote = headline[cursor];
    if (quote !== '"' && quote !== "'") {
      output += quote;
      cursor += 1;
      continue;
    }

    const end = findClosingQuote(headline, cursor, quote);
    if (end === -1) {
      output += headline.slice(cursor);
      break;
    }
    const preserve = quote === '"' && hasPostgresIdentifierContext(headline, cursor);
    output += preserve ? headline.slice(cursor, end + 1) : "<str>";
    cursor = end + 1;
  }
  return output;
}

function findClosingQuote(value: string, start: number, quote: string): number {
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    if (value[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (value[cursor] !== quote) continue;
    if (value[cursor + 1] === quote) {
      cursor += 1;
      continue;
    }
    return cursor;
  }
  return -1;
}

function hasPostgresIdentifierContext(value: string, quoteIndex: number): boolean {
  let end = quoteIndex;
  while (end > 0 && (value[end - 1] === " " || value[end - 1] === "\t")) end -= 1;
  let start = end;
  while (start > 0 && isAsciiLetterCode(value.charCodeAt(start - 1))) start -= 1;
  return POSTGRES_IDENTIFIER_CONTEXTS.has(value.slice(start, end).toLowerCase());
}

// Vercel log drains can emit one four-line runtime envelope per request. Its
// request ID, path, timings, and memory figures are occurrence metadata, not
// error identity. Recognize exactly four lines and require the same request ID
// on START/END/REPORT so application output is never mistaken for the envelope.
const START_REQUEST_ID = "START RequestId:";
const END_REQUEST_ID = "END RequestId:";
const REPORT_REQUEST_ID = "REPORT RequestId:";
const VERSION_METADATA = "Version:";

function normalizeVercelRuntimeRequest(body: string): string | null {
  const lines = body
    .trim()
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length !== 4) return null;

  const [startLine, requestLine, endLine, reportLine] = lines;
  if (!startLine || !requestLine || !endLine || !reportLine) return null;

  const requestId = startRequestId(startLine);
  if (!requestId || requestIdFromLine(endLine, END_REQUEST_ID) !== requestId) return null;
  if (reportRequestId(reportLine) !== requestId) return null;

  const request = parseVercelRequestLine(requestLine);
  return request
    ? `vercel runtime request method=${request.method.toLowerCase()} status=${request.status}`
    : null;
}

function startRequestId(line: string): string | null {
  if (!line.startsWith(START_REQUEST_ID)) return null;
  const rest = line.slice(START_REQUEST_ID.length).trim();
  if (!rest) return null;

  const boundary = firstWhitespaceIndex(rest);
  if (boundary === -1) return rest;

  const requestId = rest.slice(0, boundary);
  const metadata = rest.slice(boundary).trimStart();
  if (!metadata.startsWith(VERSION_METADATA)) return null;
  const version = metadata.slice(VERSION_METADATA.length).trim();
  return version && !hasWhitespace(version) ? requestId : null;
}

function requestIdFromLine(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  const requestId = line.slice(prefix.length).trim();
  return requestId && !hasWhitespace(requestId) ? requestId : null;
}

function reportRequestId(line: string): string | null {
  if (!line.startsWith(REPORT_REQUEST_ID)) return null;
  const rest = line.slice(REPORT_REQUEST_ID.length).trimStart();
  if (!rest) return null;
  const boundary = firstWhitespaceIndex(rest);
  return boundary === -1 ? rest : rest.slice(0, boundary);
}

function parseVercelRequestLine(line: string): { method: string; status: string } | null {
  if (!line.startsWith("[")) return null;
  const methodEnd = line.indexOf("]");
  if (methodEnd <= 1) return null;

  const method = line.slice(1, methodEnd);
  if (!isAsciiLetters(method) || !isWhitespace(line[methodEnd + 1])) return null;

  let pathStart = methodEnd + 1;
  while (isWhitespace(line[pathStart])) pathStart += 1;

  const statusStart = line.lastIndexOf("status=");
  if (statusStart <= pathStart || !isWhitespace(line[statusStart - 1])) return null;

  let pathEnd = statusStart;
  while (pathEnd > pathStart && isWhitespace(line[pathEnd - 1])) pathEnd -= 1;
  const path = line.slice(pathStart, pathEnd);
  const status = line.slice(statusStart + "status=".length).trim();
  if (!path || hasWhitespace(path) || !isThreeDigits(status)) return null;

  return { method, status };
}

function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespace(value[index])) return index;
  }
  return -1;
}

function hasWhitespace(value: string): boolean {
  return firstWhitespaceIndex(value) !== -1;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "";
}

function isAsciiLetters(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    if (!isUppercase && !isLowercase) return false;
  }
  return true;
}

function isThreeDigits(value: string): boolean {
  if (value.length !== 3) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

// Reads JavaScript (V8, Firefox, and Safari) and Python stack traces,
// innermost frame first, without frames that carry no location. A frame
// repeated by recursion counts once.
function parseFrames(stacktrace: string): Frame[] {
  const frames = /^\s*File "/m.test(stacktrace) ? parsePythonFrames(stacktrace) : parseJavaScriptFrames(stacktrace);
  return frames.filter((frame, index) => {
    const previous = frames[index - 1];
    return !previous || previous.fn !== frame.fn || previous.path !== frame.path;
  });
}

// Python prints the innermost frame last.
export function parsePythonFrames(stacktrace: string): Frame[] {
  const out: Frame[] = [];
  for (const raw of stacktrace.split("\n")) {
    const match = raw.trim().match(/^File "(.+?)", line \d+(?:, in (.+))?$/);
    if (match) out.push({ fn: match[2]?.trim() || null, path: match[1] ?? "" });
  }
  return out.reverse();
}

function parseJavaScriptFrames(stacktrace: string): Frame[] {
  const out: Frame[] = [];
  const v8 = /^\s*at /m.test(stacktrace);
  for (const raw of stacktrace.split("\n")) {
    const line = raw.trim();
    // Firefox follows a callback's frames with where it was registered, as
    // `EventListener.handleEvent*fn@...` or `setTimeout handler*fn@...`.
    // Other browsers end the stack at the callback, so the stack ends here.
    // `async*fn@...` is an awaiting caller, which V8 also shows.
    const marker = v8 ? null : line.match(/^([^@*\s][^@*]*)\*(?=[^@]*@\S+:\d+(?::\d+)?$)/);
    if (marker && marker[1] !== "async") break;
    const frame = parseJavaScriptFrame(marker ? line.slice(marker[0].length) : line);
    if (!frame || LOW_QUALITY_PATHS.has(frame.path) || frame.fn === "eval") continue;
    out.push(frame);
  }
  return out;
}

// V8 writes `at fn (path:line:col)` or `at path:line:col`. Firefox and Safari
// write `fn@path:line:col`, with an empty name for anonymous code.
function parseJavaScriptFrame(line: string): Frame | null {
  if (line.startsWith("at ")) {
    const body = line.slice(3);
    // Code run by eval has no file of its own.
    if (body.includes("(eval at ")) return null;
    const withFn = body.match(/^(.+?)\s+\((?:address at )?(.+?)(?::\d+){1,2}\)$/);
    if (withFn) return { fn: javaScriptFunction(withFn[1]), path: withFn[2] ?? "" };
    const bare = body.match(/^(?:address at )?(.+?):\d+:\d+$/);
    return bare ? { fn: null, path: bare[1] ?? "" } : null;
  }
  const gecko = line.match(/^([^@\s(]*(?:\s[^@\s(]+)*)@(.+?)(?::\d+){1,2}$/) ?? line.match(/^([^@\s(]*)@(\[native code\])$/);
  if (!gecko) return null;
  const path = gecko[2] ?? "";
  // Firefox marks eval and Function code as `path line N > eval`.
  if (/ line \d+ > /.test(path)) return null;
  return { fn: javaScriptFunction(gecko[1]), path };
}

// The function's own name, which browsers agree on: `Object.load`,
// `async Loader.load`, and `new Loader` become `load` and `Loader`.
// Anonymous functions have no name.
function javaScriptFunction(raw: string | undefined): string | null {
  let fn = (raw ?? "").trim().replace(/\s+\[as [^\]]+\]$/, "");
  fn = fn.replace(/^(?:async|new)\s+/, "");
  // Safari names top-level code `global code` or `module code`.
  if (!fn || ANONYMOUS_FUNCTIONS.has(fn) || fn.endsWith("/<") || / code$/.test(fn)) return null;
  const name = fn.split(".").at(-1) ?? fn;
  return name && !ANONYMOUS_FUNCTIONS.has(name) ? name : null;
}

function isUserFrame(f: Frame): boolean {
  return !IGNORE_PATH.some((re) => re.test(f.path));
}

function formatFrame(f: Frame): string {
  const path = normalizePath(f.path);
  return f.fn ? `${f.fn}@${path}` : path;
}

function normalizePath(p: string): string {
  let out = p
    // A script's host and query change with the deployment, preview, or
    // CDN that served it, not with the code.
    .replace(/^https?:\/\/[^/]+(\/[^?#]*)(?:[?#].*)?$/i, "$1")
    .replace(/^webpack-internal:\/\/\/?/, "")
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^\([^)]*\)\//, "")
    .replace(/^\.\//, "")
    .replace(/^file:\/\//, "")
    // iOS assigns each installed app a different UUID-named sandbox. Hermes
    // includes that absolute sandbox path in frames, but it is deployment
    // metadata rather than part of the failing code's identity.
    .replace(
      /\/var\/mobile\/Containers\/Data\/Application\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
      "/var/mobile/Containers/Data/Application/<uuid>/",
    )
    // Expo gives the generated Hermes bundle a build-specific name. The
    // function names still identify the failing code across app releases.
    .replace(/(\/\.expo-internal\/)[^/]+\.(?:js)?bundle$/i, "$1<bundle>");

  // Browser stack URLs can append deployment or cache metadata to any Next.js
  // chunk, including stable filenames such as `main-app.js`. Strip that suffix
  // before normalizing generated content hashes below.
  out = out.replace(
    /(\/(?:\.next|_next)\/(?:server|static)\/(?:[^/]+\/)*[^/?#]+(?:\._)?\.js)(?:[?#].*)$/gi,
    "$1",
  );

  // Next.js/Turbopack puts content hashes in generated chunk filenames. The
  // same source stack can therefore acquire a different path identity across
  // chunks (or builds), which must not create a fresh issue fingerprint.
  out = out.replace(
    /(\/(?:\.next|_next)\/(?:server|static)\/(?:[^/]+\/)*[^/]*?)[0-9a-f]{8,}((?:\._)?\.js)$/gi,
    "$1<hash>$2",
  );
  out = removeBundleHash(out);
  out = out.replace(/^.*?\/((?:apps|packages|src|app|lib|pages)\/.*)$/, "$1");
  return out;
}

// Bundlers put a content hash in each generated file's name, so the same code
// gets a new path every build: Vite and Rollup `index-B9xK3d2a.js`, webpack
// `main.4f3a2b1c.chunk.js`, esbuild `chunk-ABCD2345.js`, and Turbopack
// `apps_1cfrrbb._.js`.
function removeBundleHash(path: string): string {
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const turbopack = file.replace(/(^|_)[0-9a-z-]{7}(\._\.js)$/, "$1<hash>$2");
  if (turbopack !== file) return directory + turbopack;
  const extension = "((?:\\.chunk)?\\.(?:m?js|cjs|css))$";
  const hex = file.match(new RegExp(`^(.+)([-.])(?=[a-f]*\\d)[0-9a-f]{7,}${extension}`, "i"));
  if (hex) return `${directory}${hex[1]}${hex[2]}<hash>${hex[3]}`;
  const short = file.match(new RegExp(`^(.+)-([A-Za-z0-9_-]{8})${extension}`));
  if (!short) return path;
  const [, name, token, suffix] = short;
  // An eight-letter word such as `polyfill` or `Settings` is a name, not a hash.
  const looksGenerated = /\d/.test(token!) || (/[a-z]/.test(token!) && /[A-Z]/.test(token!) && !/^[A-Z][a-z]+$/.test(token!));
  return looksGenerated ? `${directory}${name}-<hash>${suffix}` : path;
}
