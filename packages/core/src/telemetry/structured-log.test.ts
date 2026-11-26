import { describe, expect, it } from "vitest";
import { fieldsSeverity, jsonLogFields, levelSeverity, structuredLogLine } from "./structured-log.js";

describe("jsonLogFields", () => {
  it("reads one JSON object and nothing else", () => {
    expect(jsonLogFields(' {"level":"error"}\n')).toEqual({ level: "error" });
    expect(jsonLogFields("[1]")).toBeNull();
    expect(jsonLogFields('{"level":')).toBeNull();
    expect(jsonLogFields("plain text")).toBeNull();
    expect(jsonLogFields({ level: "error" })).toBeNull();
    expect(jsonLogFields(`{"pad":"${"x".repeat(70_000)}"}`)).toBeNull();
  });
});

describe("structuredLogLine", () => {
  it("reads pino's msg and err", () => {
    expect(structuredLogLine(JSON.stringify({
      err: { message: "connect ETIMEDOUT", stack: "Error: connect ETIMEDOUT\n    at x (a.js:1:1)", type: "Error" },
      level: 50,
      msg: "Could not load the invoice",
    }))).toEqual({
      errorMessage: "connect ETIMEDOUT",
      errorType: "Error",
      message: "Could not load the invoice: connect ETIMEDOUT",
      stacktrace: "Error: connect ETIMEDOUT\n    at x (a.js:1:1)",
    });
  });

  it("takes the type from the stack when the error names none", () => {
    expect(structuredLogLine(JSON.stringify({ error: "No phone", message: "Failed", stack: "ContextError: No phone\n    at y (b.js:1:1)" })))
      .toMatchObject({ errorType: "ContextError", message: "Failed: No phone" });
  });

  it("uses the error as the message when the line has no other", () => {
    expect(structuredLogLine(JSON.stringify({ error: { message: "boom" }, level: "error" }))).toMatchObject({ message: "boom" });
    expect(structuredLogLine(JSON.stringify({ event: "job failed", level: "error" }))).toMatchObject({ message: "job failed" });
  });

  it("is null when the line says nothing", () => {
    expect(structuredLogLine(JSON.stringify({ level: "error", pid: 1 }))).toBeNull();
    expect(structuredLogLine("Error: plain")).toBeNull();
  });
});

describe("levelSeverity and fieldsSeverity", () => {
  it("maps names in any case and pino's numbers, and nothing else", () => {
    expect(levelSeverity("Error")).toEqual({ number: 17, text: "ERROR" });
    expect(levelSeverity(40)).toEqual({ number: 13, text: "WARN" });
    expect(levelSeverity("__proto__")).toBeUndefined();
    expect(levelSeverity("toString")).toBeUndefined();
    expect(levelSeverity(45)).toBeUndefined();
  });

  it("takes the first level field that names a known level", () => {
    expect(fieldsSeverity({ level: "notice", severity: "ERROR" })).toEqual({ number: 17, text: "ERROR" });
    expect(fieldsSeverity({ levelname: "WARNING" })).toEqual({ number: 13, text: "WARN" });
    expect(fieldsSeverity({ level: "loud" })).toBeUndefined();
  });
});

describe("structuredLogLine with stacks", () => {
  const traceback = [
    "Traceback (most recent call last):",
    '  File "/srv/app/jobs.py", line 7, in run',
    "KeyError: 'clinic_id'",
  ].join("\n");

  it("keeps a stack when the line has no message", () => {
    expect(structuredLogLine(JSON.stringify({ level: "error", stack: "TypeError: x is undefined\n    at f (a.js:1:1)" })))
      .toMatchObject({ errorType: "TypeError", message: "TypeError", stacktrace: "TypeError: x is undefined\n    at f (a.js:1:1)" });
  });

  it("reads a Python traceback given as the error as the stack", () => {
    expect(structuredLogLine(JSON.stringify({ event: "job failed", exception: traceback }))).toEqual({
      errorMessage: "'clinic_id'",
      errorType: "KeyError",
      message: "job failed: 'clinic_id'",
      stacktrace: traceback,
    });
  });

  it("reads a nested error stacktrace", () => {
    expect(structuredLogLine(JSON.stringify({ error: { message: "boom", stacktrace: traceback }, msg: "failed" })))
      .toMatchObject({ errorType: "KeyError", stacktrace: traceback });
  });
});
