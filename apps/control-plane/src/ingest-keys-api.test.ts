import { describe, expect, it } from "vitest";
import { otlpEnvironment } from "./ingest-keys-api";

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
