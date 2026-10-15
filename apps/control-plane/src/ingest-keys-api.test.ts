import { describe, expect, it } from "vitest";
import { ingestKeyPlaceholder, openTelemetryPrompt, otlpEnvironment } from "./ingest-keys-api";

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
