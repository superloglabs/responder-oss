import { describe, expect, it } from "vitest";
import { defaultIngestKeyName, ingestKeyPlaceholder, ingestKeyUsage, openTelemetryPrompt, otlpEnvironment } from "./ingest-keys-api";

describe("otlpEnvironment", () => {
  it("points an SDK at this cell's ingest endpoint with the key", () => {
    expect(otlpEnvironment("https://superlog.sh/", "sl_ingest_x")).toBe(
      [
        "export OTEL_EXPORTER_OTLP_ENDPOINT=https://superlog.sh/api/ingest",
        "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
        "export OTEL_EXPORTER_OTLP_HEADERS=x-api-key=sl_ingest_x",
      ].join("\n"),
    );
  });
});

describe("openTelemetryPrompt", () => {
  it("asks for all three signals over OTLP with the key", () => {
    const prompt = openTelemetryPrompt("https://superlog.sh", "sl_ingest_x");

    expect(prompt).toContain("logs, traces and metrics");
    expect(prompt).toContain("   OTEL_EXPORTER_OTLP_ENDPOINT=https://superlog.sh/api/ingest");
    expect(prompt).toContain("   OTEL_EXPORTER_OTLP_HEADERS=x-api-key=sl_ingest_x");
    expect(prompt).not.toContain("export ");
  });

  it("uses a placeholder until a key exists", () => {
    expect(openTelemetryPrompt("https://superlog.sh")).toContain(`x-api-key=${ingestKeyPlaceholder}`);
  });
});

describe("ingestKeyUsage", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("says when the key last sent telemetry", () => {
    expect(ingestKeyUsage({ lastUsedAt: null }, now)).toBe("Never used");
    expect(ingestKeyUsage({ lastUsedAt: "2026-10-15T11:59:30Z" }, now)).toBe("Used just now");
    expect(ingestKeyUsage({ lastUsedAt: "2026-10-15T11:45:00Z" }, now)).toBe("Used 15 minutes ago");
    expect(ingestKeyUsage({ lastUsedAt: "2026-10-15T11:00:00Z" }, now)).toBe("Used 1 hour ago");
    expect(ingestKeyUsage({ lastUsedAt: "2026-10-12T12:00:00Z" }, now)).toBe("Used 3 days ago");
  });
});

describe("defaultIngestKeyName", () => {
  it("names the key after when it was created", () => {
    expect(defaultIngestKeyName(new Date("2026-10-15T14:32:00Z"), "UTC")).toBe("Created Oct 15, 14:32");
  });
});
