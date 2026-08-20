import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  type DescribeAlarmHistoryCommandInput,
  type DescribeAlarmHistoryCommandOutput,
  type DescribeAlarmsCommandInput,
  type DescribeAlarmsCommandOutput,
  type GetMetricDataCommandInput,
  type GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  type GetQueryResultsCommandInput,
  type GetQueryResultsCommandOutput,
  type StartQueryCommandInput,
  type StartQueryCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  type GetFunctionConfigurationCommandInput,
  type GetFunctionConfigurationCommandOutput,
  type ListEventSourceMappingsCommandInput,
  type ListEventSourceMappingsCommandOutput,
} from "@aws-sdk/client-lambda";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  type GetQueueAttributesCommandInput,
  type GetQueueAttributesCommandOutput,
  type GetQueueUrlCommandInput,
  type GetQueueUrlCommandOutput,
  type QueueAttributeName,
} from "@aws-sdk/client-sqs";
import { tool } from "@openai/agents";
import type { RuntimeAwsConnection } from "@responder/core/db/investigations";
import { isAwsCommercialRegion } from "@responder/core/integrations/aws";
import { z } from "zod";
import { createRefreshingAwsCredentialsProvider } from "./aws.js";

const MAX_LOG_QUERY_POLLS = 30;
const LOG_QUERY_POLL_INTERVAL_MS = 1_000;
const MAX_INSPECTION_RANGE_MS = 24 * 60 * 60 * 1_000;
const SQS_INSPECTION_ATTRIBUTES: QueueAttributeName[] = [
  "ApproximateNumberOfMessages",
  "ApproximateNumberOfMessagesDelayed",
  "ApproximateNumberOfMessagesNotVisible",
  "CreatedTimestamp",
  "DelaySeconds",
  "LastModifiedTimestamp",
  "MaximumMessageSize",
  "MessageRetentionPeriod",
  "QueueArn",
  "ReceiveMessageWaitTimeSeconds",
  "RedriveAllowPolicy",
  "RedrivePolicy",
  "SqsManagedSseEnabled",
  "VisibilityTimeout",
];

export interface AwsInspectionClients {
  describeAlarmHistory(
    input: DescribeAlarmHistoryCommandInput,
  ): Promise<DescribeAlarmHistoryCommandOutput>;
  describeAlarms(
    input: DescribeAlarmsCommandInput,
  ): Promise<DescribeAlarmsCommandOutput>;
  getFunctionConfiguration(
    input: GetFunctionConfigurationCommandInput,
  ): Promise<GetFunctionConfigurationCommandOutput>;
  getMetricData(
    input: GetMetricDataCommandInput,
  ): Promise<GetMetricDataCommandOutput>;
  getQueryResults(
    input: GetQueryResultsCommandInput,
  ): Promise<GetQueryResultsCommandOutput>;
  getQueueAttributes(
    input: GetQueueAttributesCommandInput,
  ): Promise<GetQueueAttributesCommandOutput>;
  getQueueUrl(input: GetQueueUrlCommandInput): Promise<GetQueueUrlCommandOutput>;
  listEventSourceMappings(
    input: ListEventSourceMappingsCommandInput,
  ): Promise<ListEventSourceMappingsCommandOutput>;
  startQuery(input: StartQueryCommandInput): Promise<StartQueryCommandOutput>;
}

export type AwsInspectionClientFactory = (
  connection: RuntimeAwsConnection,
  region: string,
) => AwsInspectionClients;

function sdkInspectionClients(
  region: string,
  credentials: ReturnType<typeof createRefreshingAwsCredentialsProvider>,
): AwsInspectionClients {
  const config = { credentials, maxAttempts: 3, region };
  const cloudWatch = new CloudWatchClient(config);
  const logs = new CloudWatchLogsClient(config);
  const lambda = new LambdaClient(config);
  const sqs = new SQSClient(config);
  return {
    describeAlarmHistory: (input) =>
      cloudWatch.send(new DescribeAlarmHistoryCommand(input)),
    describeAlarms: (input) =>
      cloudWatch.send(new DescribeAlarmsCommand(input)),
    getFunctionConfiguration: (input) =>
      lambda.send(new GetFunctionConfigurationCommand(input)),
    getMetricData: (input) =>
      cloudWatch.send(new GetMetricDataCommand(input)),
    getQueryResults: (input) =>
      logs.send(new GetQueryResultsCommand(input)),
    getQueueAttributes: (input) =>
      sqs.send(new GetQueueAttributesCommand(input)),
    getQueueUrl: (input) => sqs.send(new GetQueueUrlCommand(input)),
    listEventSourceMappings: (input) =>
      lambda.send(new ListEventSourceMappingsCommand(input)),
    startQuery: (input) => logs.send(new StartQueryCommand(input)),
  };
}

function selectedConnection(
  connections: RuntimeAwsConnection[],
  accountId?: string,
): RuntimeAwsConnection {
  if (accountId) {
    const connection = connections.find(
      (candidate) => awsAccountId(candidate) === accountId,
    );
    if (!connection) throw new Error("Choose a connected AWS account");
    return connection;
  }
  if (connections.length !== 1) {
    throw new Error(
      "Specify accountId when more than one AWS account is connected",
    );
  }
  return connections[0]!;
}

function awsAccountId(connection: RuntimeAwsConnection): string {
  return connection.roleArn.split(":")[4] ?? "";
}

function withoutMetadata<T extends { $metadata?: unknown }>(
  output: T,
): Omit<T, "$metadata"> {
  const value = { ...output };
  delete value.$metadata;
  return value;
}

const accountIdParameter = z
  .string()
  .regex(/^\d{12}$/u)
  .optional()
  .describe("Connected AWS account ID; required when multiple are connected");
const regionParameter = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .refine(isAwsCommercialRegion, "Region must use the commercial AWS partition")
  .describe("AWS region, for example eu-west-1");
const timestampParameter = z.iso.datetime({ offset: true });

function validateInspectionRange(startTime: Date, endTime: Date): void {
  if (endTime <= startTime) throw new Error("endTime must follow startTime");
  if (endTime.getTime() - startTime.getTime() > MAX_INSPECTION_RANGE_MS) {
    throw new Error("AWS inspection time range must not exceed 24 hours");
  }
}

export function createAwsInspectionTools(
  connections: RuntimeAwsConnection[],
  options: {
    clientFactory?: AwsInspectionClientFactory;
    delay?: (milliseconds: number) => Promise<void>;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  if (connections.length === 0) return [];

  const credentials = new Map(
    connections.map((connection) => [
      connection.accountId,
      createRefreshingAwsCredentialsProvider(
        connection,
        options.environment,
      ),
    ]),
  );
  const clientCache = new Map<string, AwsInspectionClients>();
  const clientFactory =
    options.clientFactory ??
    ((connection: RuntimeAwsConnection, region: string) =>
      sdkInspectionClients(region, credentials.get(connection.accountId)!));
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  function clients(accountId: string | undefined, region: string) {
    const connection = selectedConnection(connections, accountId);
    const key = `${connection.accountId}:${region}`;
    let value = clientCache.get(key);
    if (!value) {
      value = clientFactory(connection, region);
      clientCache.set(key, value);
    }
    return { clients: value, connection };
  }

  const inspectCloudWatchAlarm = tool({
    name: "aws_inspect_cloudwatch_alarm",
    description:
      "Read one CloudWatch alarm and its bounded state/action history. Use this first for an AWS alarm; it returns the affected metric namespace and dimensions without requiring a script.",
    parameters: z.object({
      accountId: accountIdParameter,
      alarmName: z.string().trim().min(1).max(255),
      endTime: timestampParameter.optional(),
      historyItems: z.number().int().min(1).max(100).default(25),
      region: regionParameter,
      startTime: timestampParameter.optional(),
    }),
    async execute(input) {
      const { clients: aws, connection } = clients(
        input.accountId,
        input.region,
      );
      const [alarms, history] = await Promise.all([
        aws.describeAlarms({ AlarmNames: [input.alarmName] }),
        aws.describeAlarmHistory({
          AlarmName: input.alarmName,
          EndDate: input.endTime ? new Date(input.endTime) : undefined,
          MaxRecords: input.historyItems,
          StartDate: input.startTime ? new Date(input.startTime) : undefined,
        }),
      ]);
      const alarm =
        alarms.MetricAlarms?.[0] ??
        alarms.CompositeAlarms?.[0] ??
        alarms.LogAlarms?.[0];
      if (!alarm) throw new Error("CloudWatch alarm was not found");
      return {
        accountId: awsAccountId(connection),
        alarm,
        history: history.AlarmHistoryItems ?? [],
        nextToken: history.NextToken,
        region: input.region,
      };
    },
  });

  const inspectCloudWatchMetric = tool({
    name: "aws_inspect_cloudwatch_metric",
    description:
      "Read bounded CloudWatch metric datapoints for one namespace, metric, statistic, and set of dimensions. Use alarm output to supply the exact metric identity.",
    parameters: z.object({
      accountId: accountIdParameter,
      dimensions: z.array(
        z.object({
          name: z.string().trim().min(1).max(255),
          value: z.string().max(1_024),
        }),
      ).max(30).default([]),
      endTime: timestampParameter,
      metricName: z.string().trim().min(1).max(255),
      namespace: z.string().trim().min(1).max(255),
      periodSeconds: z.number().int().min(1).max(86_400).default(60),
      region: regionParameter,
      startTime: timestampParameter,
      statistic: z
        .enum(["Average", "Maximum", "Minimum", "SampleCount", "Sum"])
        .default("Sum"),
    }),
    async execute(input) {
      const startTime = new Date(input.startTime);
      const endTime = new Date(input.endTime);
      validateInspectionRange(startTime, endTime);
      const { clients: aws, connection } = clients(
        input.accountId,
        input.region,
      );
      const output = await aws.getMetricData({
        EndTime: endTime,
        MetricDataQueries: [
          {
            Id: "metric",
            MetricStat: {
              Metric: {
                Dimensions: input.dimensions.map(({ name, value }) => ({
                  Name: name,
                  Value: value,
                })),
                MetricName: input.metricName,
                Namespace: input.namespace,
              },
              Period: input.periodSeconds,
              Stat: input.statistic,
            },
            ReturnData: true,
          },
        ],
        ScanBy: "TimestampAscending",
        StartTime: startTime,
      });
      return {
        accountId: awsAccountId(connection),
        metricData: output.MetricDataResults ?? [],
        nextToken: output.NextToken,
        region: input.region,
      };
    },
  });

  const inspectSqsQueue = tool({
    name: "aws_inspect_sqs_queue",
    description:
      "Read one SQS queue's URL and operational attributes without receiving, deleting, or changing messages.",
    parameters: z.object({
      accountId: accountIdParameter,
      queueName: z.string().trim().min(1).max(80),
      region: regionParameter,
    }),
    async execute(input) {
      const { clients: aws, connection } = clients(
        input.accountId,
        input.region,
      );
      const queue = await aws.getQueueUrl({ QueueName: input.queueName });
      const queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error("SQS queue was not found");
      const attributes = await aws.getQueueAttributes({
        AttributeNames: SQS_INSPECTION_ATTRIBUTES,
        QueueUrl: queueUrl,
      });
      return {
        accountId: awsAccountId(connection),
        attributes: attributes.Attributes ?? {},
        queueName: input.queueName,
        queueUrl,
        region: input.region,
      };
    },
  });

  const inspectLambdaFunction = tool({
    name: "aws_inspect_lambda_function",
    description:
      "Read a Lambda function's non-secret runtime configuration and event source mappings. Environment variables are always omitted.",
    parameters: z.object({
      accountId: accountIdParameter,
      functionName: z.string().trim().min(1).max(140),
      region: regionParameter,
    }),
    async execute(input) {
      const { clients: aws, connection } = clients(
        input.accountId,
        input.region,
      );
      const [rawConfiguration, mappings] = await Promise.all([
        aws.getFunctionConfiguration({ FunctionName: input.functionName }),
        aws.listEventSourceMappings({
          FunctionName: input.functionName,
          MaxItems: 100,
        }),
      ]);
      const configuration = withoutMetadata(rawConfiguration);
      delete configuration.Environment;
      delete configuration.KMSKeyArn;
      return {
        accountId: awsAccountId(connection),
        configuration,
        eventSourceMappings: mappings.EventSourceMappings ?? [],
        nextMarker: mappings.NextMarker,
        region: input.region,
      };
    },
  });

  const queryCloudWatchLogs = tool({
    name: "aws_query_cloudwatch_logs",
    description:
      "Run one bounded CloudWatch Logs Insights query and wait up to 30 seconds for its read-only results.",
    parameters: z.object({
      accountId: accountIdParameter,
      endTime: timestampParameter,
      limit: z.number().int().min(1).max(200).default(100),
      logGroupName: z.string().trim().min(1).max(512),
      queryString: z.string().trim().min(1).max(10_000),
      region: regionParameter,
      startTime: timestampParameter,
    }),
    async execute(input) {
      const startTime = new Date(input.startTime);
      const endTime = new Date(input.endTime);
      validateInspectionRange(startTime, endTime);
      const { clients: aws, connection } = clients(
        input.accountId,
        input.region,
      );
      const started = await aws.startQuery({
        endTime: Math.floor(endTime.getTime() / 1_000),
        limit: input.limit,
        logGroupName: input.logGroupName,
        queryString: input.queryString,
        startTime: Math.floor(startTime.getTime() / 1_000),
      });
      if (!started.queryId) throw new Error("CloudWatch Logs query did not start");

      let output: GetQueryResultsCommandOutput | undefined;
      for (let attempt = 0; attempt < MAX_LOG_QUERY_POLLS; attempt += 1) {
        output = await aws.getQueryResults({ queryId: started.queryId });
        if (output.status === "Complete") break;
        if (["Cancelled", "Failed", "Timeout", "Unknown"].includes(
          output.status ?? "Unknown",
        )) {
          throw new Error(`CloudWatch Logs query ${output.status ?? "failed"}`);
        }
        await delay(LOG_QUERY_POLL_INTERVAL_MS);
      }
      if (output?.status !== "Complete") {
        throw new Error("CloudWatch Logs query did not complete within 30 seconds");
      }
      return {
        accountId: awsAccountId(connection),
        queryId: started.queryId,
        region: input.region,
        results: output?.results ?? [],
        statistics: output?.statistics,
        status: output?.status ?? "Unknown",
      };
    },
  });

  return [
    inspectCloudWatchAlarm,
    inspectCloudWatchMetric,
    inspectSqsQueue,
    inspectLambdaFunction,
    queryCloudWatchLogs,
  ];
}
