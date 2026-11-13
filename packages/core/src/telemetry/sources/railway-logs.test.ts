import { describe, expect, it } from "vitest";
import { type RailwayLogLine, railwayLogBlocks, railwayLogsToOtlp, railwaySeverity } from "./railway-logs.js";

function line(message: string, timestamp: string, overrides: Partial<RailwayLogLine> = {}): RailwayLogLine {
  return {
    attributes: [{ key: "level", value: overrides.severity ?? "error" }],
    message,
    severity: "error",
    tags: { deploymentId: "dep-1", deploymentInstanceId: "replica-1", serviceId: "svc-api" },
    timestamp,
    ...overrides,
  };
}

describe("railwaySeverity", () => {
  it("keeps Railway's level", () => {
    expect(railwaySeverity({ message: "ready", severity: "info" })).toEqual({ number: 9, text: "INFO" });
    expect(railwaySeverity({ message: "slow", severity: "warn" })).toEqual({ number: 13, text: "WARN" });
    expect(railwaySeverity({ message: "boom", severity: "error" })).toEqual({ number: 17, text: "ERROR" });
  });

  it("lowers a stderr line that names a lower level", () => {
    expect(railwaySeverity({ message: 'INFO:     10.0.0.1:0 - "GET /health HTTP/1.1" 200 OK', severity: "error" }).text).toBe("INFO");
    expect(railwaySeverity({ message: "[2026-11-13 10:00:00,120] WARNING slow query", severity: "error" }).text).toBe("WARN");
    expect(railwaySeverity({ message: 'time=2026-11-13T10:00:00Z level=debug msg="cache hit"', severity: "error" }).text).toBe("DEBUG");
  });

  it("keeps an error whose text only mentions a level", () => {
    expect(railwaySeverity({ message: "Information about the failed payment", severity: "error" }).text).toBe("ERROR");
    expect(railwaySeverity({ message: "ERROR: payment failed", severity: "error" }).text).toBe("ERROR");
  });
});

describe("railwayLogBlocks", () => {
  it("joins a Node stack trace into one log", () => {
    const blocks = railwayLogBlocks([
      line("    at charge (/app/dist/payments.js:10:5)", "2026-11-13T10:00:00.000000200Z"),
      line("TypeError: Cannot read properties of undefined (reading 'id')", "2026-11-13T10:00:00.000000100Z"),
      line("    at async handler (/app/dist/server.js:42:3)", "2026-11-13T10:00:00.000000300Z"),
      line("next request", "2026-11-13T10:00:01.000000000Z", { severity: "info" }),
    ]);
    expect(blocks.map((block) => block.lines)).toEqual([
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at charge (/app/dist/payments.js:10:5)",
        "    at async handler (/app/dist/server.js:42:3)",
      ],
      ["next request"],
    ]);
  });

  it("joins a chained Python traceback, ending at each exception line", () => {
    const messages = [
      "Traceback (most recent call last):",
      '  File "/app/main.py", line 3, in <module>',
      "    charge()",
      "KeyError: 'id'",
      "",
      "During handling of the above exception, another exception occurred:",
      "",
      "Traceback (most recent call last):",
      '  File "/app/main.py", line 5, in <module>',
      "RuntimeError: payment failed",
      "Worker restarted",
    ];
    const blocks = railwayLogBlocks(messages.map((message, index) =>
      line(message, `2026-11-13T10:00:00.${String(index * 1000).padStart(9, "0")}Z`)));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.lines).toEqual(messages.slice(0, 10));
    expect(blocks[1]!.lines).toEqual(["Worker restarted"]);
  });

  it("keeps lines from different replicas apart", () => {
    const blocks = railwayLogBlocks([
      line("Error: one", "2026-11-13T10:00:00.000000100Z"),
      line("    at a (/app/a.js:1:1)", "2026-11-13T10:00:00.000000200Z", {
        tags: { deploymentInstanceId: "replica-2", serviceId: "svc-api" },
      }),
    ]);
    expect(blocks.map((block) => block.lines.length)).toEqual([1, 1]);
  });

  it("does not join a line written long after the last one", () => {
    const blocks = railwayLogBlocks([
      line("Error: one", "2026-11-13T10:00:00Z"),
      line("    indented later", "2026-11-13T10:00:05Z"),
    ]);
    expect(blocks).toHaveLength(2);
  });
});

describe("railwayLogsToOtlp", () => {
  it("groups logs by service with Railway resource attributes", () => {
    const blocks = railwayLogBlocks([
      line("TypeError: boom", "2026-11-13T10:00:00.000000100Z"),
      line("    at charge (/app/dist/payments.js:10:5)", "2026-11-13T10:00:00.000000200Z"),
      line("ready", "2026-11-13T10:00:02Z", {
        attributes: [{ key: "level", value: "info" }, { key: "requestId", value: "req-1" }],
        severity: "info",
        tags: { deploymentId: "dep-2", deploymentInstanceId: "replica-9", serviceId: "svc-worker" },
      }),
    ]);
    const [request] = railwayLogsToOtlp(blocks, {
      environmentId: "env-prod",
      environmentName: "production",
      projectId: "project-1",
      projectName: "shop",
      services: { "svc-api": "api" },
    }, { now: new Date("2026-11-13T10:01:00Z") });

    expect(request!.resourceLogs).toHaveLength(2);
    const [api, worker] = request!.resourceLogs;
    expect(api!.resource.attributes).toEqual(expect.arrayContaining([
      { key: "service.name", value: { stringValue: "api" } },
      { key: "telemetry.source", value: { stringValue: "railway" } },
      { key: "deployment.environment.name", value: { stringValue: "production" } },
      { key: "railway.project_name", value: { stringValue: "shop" } },
    ]));
    const record = api!.scopeLogs[0]!.logRecords[0]!;
    expect(record).toMatchObject({
      body: { stringValue: "TypeError: boom\n    at charge (/app/dist/payments.js:10:5)" },
      severityNumber: 17,
      severityText: "ERROR",
      timeUnixNano: "1794564000000000100",
    });
    expect(record.attributes).toEqual(expect.arrayContaining([
      { key: "exception.type", value: { stringValue: "TypeError" } },
      { key: "exception.message", value: { stringValue: "boom" } },
      { key: "railway.deployment_id", value: { stringValue: "dep-1" } },
    ]));
    // A service whose name is not known yet keeps its ID.
    expect(worker!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "svc-worker" } });
    expect(worker!.scopeLogs[0]!.logRecords[0]!.attributes).toContainEqual({ key: "requestId", value: { stringValue: "req-1" } });
  });

  it("splits large reads into batches", () => {
    const blocks = railwayLogBlocks(Array.from({ length: 5 }, (_, index) =>
      line(`line ${index}`, `2026-11-13T10:00:0${index}Z`, { severity: "info" })));
    expect(railwayLogsToOtlp(blocks, { environmentId: "env", services: {} }, { batch: 2 })).toHaveLength(3);
  });
});
