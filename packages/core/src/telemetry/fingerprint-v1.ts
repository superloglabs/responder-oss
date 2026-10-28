import { createHash } from "node:crypto";
import { extractPsycopgHeadline, normalizeMessage, parsePythonFrames, pythonTracebackException } from "./fingerprint.js";

// The v1 fingerprint, frozen. An occurrence whose current fingerprint has no
// issue yet takes over the issue its v1 fingerprint named, so the change to
// v2 does not open every known error again as new. Remove once the issues
// that were still occurring at the change have all moved.

type Frame = { fn: string | null; path: string };

const TOP_N_FRAMES = 5;

const IGNORE_PATH = [
  /node_modules\//,
  /^node:internal\//,
  /^node:async_hooks/,
  /async_hooks\.js/,
  /^webpack:\/\/\//,
  /(?:site|dist)-packages\//,
  /\/lib\/python\d+(?:\.\d+)*\//,
  /^<frozen /,
];

function hash(canonical: string): string {
  return `v1:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export function fingerprintV1(input: {
  type: string;
  stacktrace: string | null | undefined;
  message?: string | null;
}): string {
  const type = input.type || "Error";
  const stacktrace = input.stacktrace ?? "";
  const frames = /^\s*File "/m.test(stacktrace) ? parsePythonFrames(stacktrace) : parseJavaScriptFrames(stacktrace);
  const userFrames = frames.filter((frame) => !IGNORE_PATH.some((re) => re.test(frame.path))).slice(0, TOP_N_FRAMES);
  const picked = userFrames.length > 0 ? userFrames : frames.slice(0, TOP_N_FRAMES);
  const normalized = picked.map((frame) => {
    const path = normalizePath(frame.path);
    return frame.fn ? `${frame.fn}@${path}` : path;
  });
  return hash(`${type}::${messageBucketFor(input.message)}::${normalized.join("|")}`);
}

export function fingerprintLogV1(input: {
  service: string;
  severity: string;
  body: string;
  exceptionType?: string | null;
  message?: string | null;
  stacktrace?: string | null;
}): string {
  if (input.stacktrace && input.stacktrace.trim().length > 0) {
    return fingerprintV1({
      message: input.message,
      stacktrace: input.stacktrace,
      type: input.exceptionType || input.severity || "LogError",
    });
  }
  const traceback = extractPsycopgHeadline(input.body ?? "") ? null : pythonTracebackException(input.body ?? "");
  if (traceback) {
    return fingerprintV1({ message: traceback.message, stacktrace: input.body, type: traceback.type });
  }
  const type = input.exceptionType || input.severity || "LogError";
  return hash(`log::${input.service || "unknown"}::${type}::${normalizeMessage(input.body ?? "")}`);
}

function messageBucketFor(message: string | null | undefined): string {
  if (!message) return "";
  const envelope = message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let s = envelope?.[1] ? envelope[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : message;
  s = s.replace(/https?:\/\/\S+/gi, "<url>");
  s = s.replace(/(^|\s)\/\S*/g, "$1<path>");
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  s = s.replace(/\b[A-Za-z0-9_]{20,}\b/g, "<id>");
  s = s.replace(/\b\d+\b/g, "<n>");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > 160 ? s.slice(0, 160) : s;
}

function parseJavaScriptFrames(stacktrace: string): Frame[] {
  const out: Frame[] = [];
  for (const raw of stacktrace.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);
    const withFn = body.match(/^(.+?)\s+\((.+?):\d+:\d+\)$/);
    if (withFn) {
      out.push({ fn: withFn[1] ?? null, path: withFn[2] ?? "" });
      continue;
    }
    const bare = body.match(/^(.+?):\d+:\d+$/);
    if (bare) out.push({ fn: null, path: bare[1] ?? "" });
  }
  return out;
}

function normalizePath(p: string): string {
  let out = p
    .replace(/^webpack-internal:\/\/\/?/, "")
    .replace(/^\([^)]*\)\//, "")
    .replace(/^\.\//, "")
    .replace(/^file:\/\//, "")
    .replace(
      /\/var\/mobile\/Containers\/Data\/Application\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
      "/var/mobile/Containers/Data/Application/<uuid>/",
    )
    .replace(/(\/\.expo-internal\/)[^/]+\.(?:js)?bundle$/i, "$1<bundle>");
  out = out.replace(/(\/(?:\.next|_next)\/(?:server|static)\/(?:[^/]+\/)*[^/?#]+(?:\._)?\.js)(?:[?#].*)$/gi, "$1");
  out = out.replace(/(\/(?:\.next|_next)\/(?:server|static)\/(?:[^/]+\/)*[^/]*?)[0-9a-f]{8,}((?:\._)?\.js)$/gi, "$1<hash>$2");
  return out.replace(/^.*?\/((?:apps|packages|src|app|lib|pages)\/.*)$/, "$1");
}
