import { describe, expect, it } from "vitest";
import { parseRestrictedD2 } from "./codebase-knowledge-diagram";

describe("restricted D2 diagram layout", () => {
  it("parses labels and lays a request flow out by dependency level", () => {
    const parsed = parseRestrictedD2([
      "browser: Browser",
      "api: Control plane",
      "database: PostgreSQL",
      "browser -> api: HTTPS",
      "api -> database: SQL",
    ].join("\n"));

    expect(parsed.edges).toEqual([
      expect.objectContaining({ source: "browser", target: "api", label: "HTTPS" }),
      expect.objectContaining({ source: "api", target: "database", label: "SQL" }),
    ]);
    expect(parsed.nodes).toEqual([
      { id: "browser", label: "Browser", level: 0 },
      { id: "api", label: "Control plane", level: 1 },
      { id: "database", label: "PostgreSQL", level: 2 },
    ]);
  });

  it("keeps cyclic nodes on a finite fallback level", () => {
    const parsed = parseRestrictedD2(
      "worker: Worker\nqueue: Queue\nworker -> queue\nqueue -> worker",
    );
    expect(parsed.nodes.every((node) => Number.isFinite(node.level))).toBe(true);
  });
});
