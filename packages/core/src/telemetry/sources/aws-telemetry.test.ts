import { describe, expect, it } from "vitest";
import {
  awsTelemetryCloudFormationTemplate,
  awsTelemetryDeployCommand,
  awsTelemetryQuickCreateUrl,
  awsTelemetryStackName,
  awsTelemetryStackParameters,
  createAwsTelemetryResourcePrefix,
} from "./aws-telemetry.js";

const key = `sl_ingest_${"a".repeat(43)}`;

describe("AWS telemetry stack", () => {
  it("names resources uniquely within the template's pattern", () => {
    const prefix = createAwsTelemetryResourcePrefix();
    expect(prefix).toMatch(/^[a-z0-9][a-z0-9-]{2,24}$/u);
    expect(awsTelemetryStackName(prefix)).toBe(`SuperlogTelemetry-${prefix.slice("superlog-".length)}`);
  });

  it("opens quick-create in the chosen region with the parameters", () => {
    const parameters = awsTelemetryStackParameters({ ingestKey: key, ingestOrigin: "https://eu.superlog.sh/", resourcePrefix: "superlog-ab12cd34" });
    const url = new URL(awsTelemetryQuickCreateUrl({
      parameters,
      region: "eu-west-1",
      stackName: "SuperlogTelemetry-ab12cd34",
      templateUrl: "https://bucket.s3.eu-west-3.amazonaws.com/t.yaml?X-Amz-Signature=1",
    }));

    expect(url.origin).toBe("https://eu-west-1.console.aws.amazon.com");
    const query = new URLSearchParams(url.hash.split("?")[1]);
    expect(query.get("param_IngestUrl")).toBe("https://eu.superlog.sh");
    expect(query.get("param_IngestKey")).toBe(key);
    expect(query.get("templateURL")).toContain("X-Amz-Signature=1");
    expect(() => awsTelemetryQuickCreateUrl({ parameters, region: "us-gov-west-1", stackName: "s", templateUrl: "https://x" })).toThrow();
  });

  it("matches the template's parameters and Firehose paths", () => {
    const template = awsTelemetryCloudFormationTemplate();
    for (const name of Object.keys(awsTelemetryStackParameters({ ingestKey: key, ingestOrigin: "https://x", resourcePrefix: "superlog-1" }))) {
      expect(template).toContain(`  ${name}:\n    Type: String`);
    }
    expect(template).toContain("/api/ingest/aws/firehose/metrics");
    expect(template).toContain("/api/ingest/aws/firehose/logs");
    expect(template).toContain("OutputFormat: opentelemetry1.0");
    expect(awsTelemetryDeployCommand({ parameters: { A: "1", B: "2" }, region: "us-east-1", stackName: "s" })).toContain("    A=1 \\\n    B=2");
  });
});
