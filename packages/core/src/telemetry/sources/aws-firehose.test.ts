import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  cloudWatchLogsToOtlp,
  firehoseAnswer,
  firehoseSource,
  logGroupService,
  logSeverity,
  metricStreamRequest,
} from "./aws-firehose.js";

function framed(...messages: number[][]): string {
  return Buffer.concat(messages.map((message) => Buffer.from([message.length, ...message]))).toString("base64");
}

function cloudWatchRecord(payload: Record<string, unknown>): { data: string } {
  return { data: gzipSync(JSON.stringify(payload)).toString("base64") };
}

describe("metricStreamRequest", () => {
  it("joins the length-prefixed messages of every record", () => {
    const request = { records: [{ data: framed([10, 1, 7], [10, 0]) }, { data: framed([10, 2, 8, 9]) }], requestId: "r" };

    expect([...metricStreamRequest(request)]).toEqual([10, 1, 7, 10, 0, 10, 2, 8, 9]);
  });

  it("reads multi-byte length prefixes and rejects truncated messages", () => {
    const long = new Array(200).fill(1);
    const data = Buffer.from([0xc8, 0x01, ...long]).toString("base64");
    expect(metricStreamRequest({ records: [{ data }], requestId: "r" })).toHaveLength(200);

    const truncated = Buffer.from([5, 1, 2]).toString("base64");
    expect(() => metricStreamRequest({ records: [{ data: truncated }], requestId: "r" })).toThrow("Truncated");
  });
});

describe("cloudWatchLogsToOtlp", () => {
  it("turns a subscription record into logs for its log group", () => {
    const request = {
      records: [
        cloudWatchRecord({
          logEvents: [
            { id: "1", message: '{"level":"error","msg":"boom"}', timestamp: 1_760_000_000_000 },
            { id: "2", message: "INFO started", timestamp: 1_760_000_000_500 },
          ],
          logGroup: "/aws/lambda/checkout",
          logStream: "2026/10/15/[$LATEST]abc",
          messageType: "DATA_MESSAGE",
          owner: "123456789012",
          subscriptionFilters: ["superlog"],
        }),
        cloudWatchRecord({ logEvents: [], logGroup: "", logStream: "", messageType: "CONTROL_MESSAGE", owner: "" }),
        { data: Buffer.from("not json").toString("base64") },
      ],
      requestId: "r",
    };

    const result = cloudWatchLogsToOtlp(request, { accountId: "123456789012", region: "eu-west-1" }, 1_760_000_001_000);

    expect(result.records).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.payload.resourceLogs).toHaveLength(1);
    const resource = result.payload.resourceLogs[0]!;
    expect(resource.resource.attributes).toEqual(expect.arrayContaining([
      { key: "service.name", value: { stringValue: "checkout" } },
      { key: "cloud.account.id", value: { stringValue: "123456789012" } },
      { key: "cloud.region", value: { stringValue: "eu-west-1" } },
      { key: "aws.log.group.names", value: { stringValue: "/aws/lambda/checkout" } },
    ]));
    const [first, second] = resource.scopeLogs[0]!.logRecords;
    expect(first).toMatchObject({ body: { stringValue: "boom" }, severityText: "ERROR", timeUnixNano: "1760000000000000000" });
    expect(first!.attributes).toEqual(expect.arrayContaining([{ key: "level", value: { stringValue: "error" } }]));
    expect(second).toMatchObject({ body: { stringValue: "INFO started" }, severityText: "INFO" });
  });

  it("names an ECS container's logs after the container and lifts JSON fields", () => {
    const request = {
      records: [
        cloudWatchRecord({
          logEvents: [{ id: "1", message: '{"cell":"us","event":"cell_webhook_forwarded","status":202}', timestamp: 1_760_000_000_000 }],
          logGroup: "ResponderParis-ApiLogs3D05D88B-d72MaarPZDKM",
          logStream: "api/api/24475fbb3413474eaadac9cb3445ceab",
          messageType: "DATA_MESSAGE",
          owner: "123456789012",
        }),
      ],
      requestId: "r",
    };

    const resource = cloudWatchLogsToOtlp(request, null).payload.resourceLogs[0]!;

    expect(resource.resource.attributes).toEqual(expect.arrayContaining([{ key: "service.name", value: { stringValue: "api" } }]));
    const [record] = resource.scopeLogs[0]!.logRecords;
    expect(record).toMatchObject({ body: { stringValue: "cell_webhook_forwarded" }, severityText: "" });
    expect(record!.attributes).toEqual(expect.arrayContaining([
      { key: "cell", value: { stringValue: "us" } },
      { key: "status", value: { intValue: "202" } },
    ]));
  });
});

describe("Firehose helpers", () => {
  it("reads the account and region from the delivery stream ARN", () => {
    expect(firehoseSource("arn:aws:firehose:us-east-1:123456789012:deliverystream/superlog-ab-logs")).toEqual({
      accountId: "123456789012",
      region: "us-east-1",
    });
    expect(firehoseSource("arn:aws:s3:::bucket")).toBeNull();
    expect(firehoseSource(undefined)).toBeNull();
  });

  it("answers with the request ID", () => {
    expect(firehoseAnswer("r-1", undefined, 5)).toEqual({ requestId: "r-1", timestamp: 5 });
    expect(firehoseAnswer("r-1", "nope", 5)).toEqual({ errorMessage: "nope", requestId: "r-1", timestamp: 5 });
  });

  it("finds levels and service names", () => {
    expect(logSeverity("2026-10-15T10:00:00Z [WARN] slow")?.text).toBe("WARN");
    expect(logSeverity('{"severity":"critical"}')?.text).toBe("FATAL");
    expect(logSeverity('{"level":50,"msg":"boom"}')?.text).toBe("ERROR");
    expect(logSeverity('{"msg":"ERROR in message"}')).toBeUndefined();
    expect(logSeverity("START RequestId: 1")).toBeUndefined();
    expect(logGroupService("/ecs/payments-api")).toBe("payments-api");
    expect(logGroupService("/ecs/payments-api", "ecs/web/0123456789abcdef0123456789abcdef")).toBe("web");
    expect(logGroupService("/aws/rds/instance/orders-db/postgresql")).toBe("orders-db");
    expect(logGroupService("/aws/ecs/containerinsights/ResponderParis-ClusterEB0386A7-EatE0wgcbXoE/performance")).toBe("ResponderParis-Cluster");
    expect(logGroupService("ResponderParis-ApiLogs3D05D88B-d72MaarPZDKM")).toBe("ResponderParis-ApiLogs");
    expect(logGroupService("")).toBe("aws");
  });
});
