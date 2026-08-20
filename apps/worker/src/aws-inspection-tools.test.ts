import { describe, expect, it, vi } from "vitest";
import type { RuntimeAwsConnection } from "@responder/core/db/investigations";
import {
  type AwsInspectionClients,
  createAwsInspectionTools,
} from "./aws-inspection-tools.js";

const connection: RuntimeAwsConnection = {
  accountId: "10000000-0000-4000-8000-000000000001",
  displayName: "Production AWS",
  externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
  roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
};

function fakeClients(
  overrides: Partial<AwsInspectionClients> = {},
): AwsInspectionClients {
  const empty = vi.fn().mockResolvedValue({ $metadata: {} });
  return {
    describeAlarmHistory: empty,
    describeAlarms: empty,
    getFunctionConfiguration: empty,
    getMetricData: empty,
    getQueryResults: empty,
    getQueueAttributes: empty,
    getQueueUrl: empty,
    listEventSourceMappings: empty,
    startQuery: empty,
    ...overrides,
  } as AwsInspectionClients;
}

function inspectionTool(
  name: string,
  clients: AwsInspectionClients,
  connections = [connection],
) {
  return createAwsInspectionTools(connections, {
    clientFactory: () => clients,
    delay: () => Promise.resolve(),
  }).find((candidate) => candidate.name === name)!;
}

describe("typed AWS inspection tools", () => {
  it("reads an alarm and its history using exact SDK operations", async () => {
    const describeAlarms = vi.fn().mockResolvedValue({
      $metadata: {},
      MetricAlarms: [{ AlarmName: "QueueDepthHigh", StateValue: "ALARM" }],
    });
    const describeAlarmHistory = vi.fn().mockResolvedValue({
      $metadata: {},
      AlarmHistoryItems: [{ HistorySummary: "State updated" }],
    });
    const tool = inspectionTool(
      "aws_inspect_cloudwatch_alarm",
      fakeClients({ describeAlarmHistory, describeAlarms }),
    );

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({
        alarmName: "QueueDepthHigh",
        region: "eu-west-1",
      }),
    )).resolves.toMatchObject({
      accountId: "123456789012",
      alarm: { AlarmName: "QueueDepthHigh", StateValue: "ALARM" },
      history: [{ HistorySummary: "State updated" }],
      region: "eu-west-1",
    });
    expect(describeAlarms).toHaveBeenCalledWith({
      AlarmNames: ["QueueDepthHigh"],
    });
    expect(describeAlarmHistory).toHaveBeenCalledWith(
      expect.objectContaining({ AlarmName: "QueueDepthHigh", MaxRecords: 25 }),
    );
  });

  it("reads SQS attributes without receiving messages", async () => {
    const getQueueUrl = vi.fn().mockResolvedValue({
      $metadata: {},
      QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/orders-dlq",
    });
    const getQueueAttributes = vi.fn().mockResolvedValue({
      $metadata: {},
      Attributes: { ApproximateNumberOfMessages: "404" },
    });
    const tool = inspectionTool(
      "aws_inspect_sqs_queue",
      fakeClients({ getQueueAttributes, getQueueUrl }),
    );

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({ queueName: "orders-dlq", region: "eu-west-1" }),
    )).resolves.toMatchObject({
      accountId: "123456789012",
      attributes: { ApproximateNumberOfMessages: "404" },
      queueName: "orders-dlq",
    });
    expect(getQueueAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        QueueUrl:
          "https://sqs.eu-west-1.amazonaws.com/123456789012/orders-dlq",
      }),
    );
  });

  it("reads a bounded CloudWatch metric series", async () => {
    const getMetricData = vi.fn().mockResolvedValue({
      $metadata: {},
      MetricDataResults: [
        { Id: "metric", Timestamps: [new Date("2026-08-20T12:05:00Z")], Values: [7] },
      ],
    });
    const tool = inspectionTool(
      "aws_inspect_cloudwatch_metric",
      fakeClients({ getMetricData }),
    );

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({
        dimensions: { QueueName: "orders-dlq" },
        endTime: "2026-08-20T12:10:00Z",
        metricName: "ApproximateNumberOfMessagesVisible",
        namespace: "AWS/SQS",
        region: "eu-west-1",
        startTime: "2026-08-20T12:00:00Z",
      }),
    )).resolves.toMatchObject({
      metricData: [{ Id: "metric", Values: [7] }],
    });
    expect(getMetricData).toHaveBeenCalledWith(
      expect.objectContaining({
        MetricDataQueries: [
          expect.objectContaining({
            Id: "metric",
            MetricStat: expect.objectContaining({
              Metric: expect.objectContaining({
                Dimensions: [{ Name: "QueueName", Value: "orders-dlq" }],
                MetricName: "ApproximateNumberOfMessagesVisible",
                Namespace: "AWS/SQS",
              }),
              Period: 60,
              Stat: "Sum",
            }),
          }),
        ],
      }),
    );
  });

  it("omits Lambda environment variables and KMS identifiers", async () => {
    const getFunctionConfiguration = vi.fn().mockResolvedValue({
      $metadata: {},
      Environment: { Variables: { API_KEY: "secret" } },
      FunctionName: "orders-consumer",
      KMSKeyArn: "arn:aws:kms:eu-west-1:123456789012:key/secret",
      LastUpdateStatus: "Successful",
    });
    const listEventSourceMappings = vi.fn().mockResolvedValue({
      $metadata: {},
      EventSourceMappings: [{ State: "Enabled", UUID: "mapping-1" }],
    });
    const tool = inspectionTool(
      "aws_inspect_lambda_function",
      fakeClients({ getFunctionConfiguration, listEventSourceMappings }),
    );

    const output = await tool.invoke(
      undefined as never,
      JSON.stringify({
        functionName: "orders-consumer",
        region: "eu-west-1",
      }),
    );

    expect(output).toMatchObject({
      configuration: {
        FunctionName: "orders-consumer",
        LastUpdateStatus: "Successful",
      },
      eventSourceMappings: [{ State: "Enabled", UUID: "mapping-1" }],
    });
    expect(JSON.stringify(output)).not.toContain("API_KEY");
    expect(JSON.stringify(output)).not.toContain("KMSKeyArn");
  });

  it("polls a bounded Logs Insights query to completion", async () => {
    const startQuery = vi.fn().mockResolvedValue({
      $metadata: {},
      queryId: "query-1",
    });
    const getQueryResults = vi
      .fn()
      .mockResolvedValueOnce({ $metadata: {}, status: "Running" })
      .mockResolvedValueOnce({
        $metadata: {},
        results: [[{ field: "@message", value: "failed" }]],
        status: "Complete",
      });
    const delay = vi.fn().mockResolvedValue(undefined);
    const tool = createAwsInspectionTools([connection], {
      clientFactory: () => fakeClients({ getQueryResults, startQuery }),
      delay,
    }).find((candidate) => candidate.name === "aws_query_cloudwatch_logs")!;

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({
        endTime: "2026-08-20T12:10:00Z",
        logGroupName: "/aws/lambda/orders-consumer",
        queryString: "fields @message | limit 20",
        region: "eu-west-1",
        startTime: "2026-08-20T12:00:00Z",
      }),
    )).resolves.toMatchObject({
      queryId: "query-1",
      results: [[{ field: "@message", value: "failed" }]],
      status: "Complete",
    });
    expect(delay).toHaveBeenCalledTimes(1);
    expect(startQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: 1_787_227_800,
        limit: 100,
        startTime: 1_787_227_200,
      }),
    );
  });

  it("requires the AWS account ID when multiple accounts are connected", async () => {
    const otherConnection: RuntimeAwsConnection = {
      ...connection,
      accountId: "20000000-0000-4000-8000-000000000002",
      roleArn: "arn:aws:iam::210987654321:role/ResponderInvestigationRole",
    };
    const tool = inspectionTool(
      "aws_inspect_sqs_queue",
      fakeClients(),
      [connection, otherConnection],
    );

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({ queueName: "orders-dlq", region: "eu-west-1" }),
    )).resolves.toContain(
      "Specify accountId when more than one AWS account is connected",
    );
  });
});
