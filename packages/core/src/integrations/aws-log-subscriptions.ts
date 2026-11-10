import { randomBytes } from "node:crypto";
import {
  CloudWatchLogsClient,
  DeleteAccountPolicyCommand,
  PutAccountPolicyCommand,
  PutDestinationPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { AssumeRoleCommand, STSClient, type Credentials } from "@aws-sdk/client-sts";
import { awsAccountIdSchema, AWS_MCP_SIGNING_REGION, type AwsConnectionCredentials } from "./aws.js";
import { awsRegions, isOfferedAwsRegion } from "./aws-regions.js";

// Superlog keeps one CloudWatch Logs account-level subscription policy per
// chosen region in a customer's AWS account (ADR 0015). It assumes the
// customer's ResponderLogSubscriptionRole through the log subscription
// broker. Only the API does this: investigation agents, the worker, and Signal
// never receive these credentials.

export const AWS_LOG_SUBSCRIPTION_ROLE_NAME = "ResponderLogSubscriptionRole";

// The log lines Superlog asks CloudWatch Logs to send: error, fatal, and
// critical lines, exceptions and tracebacks, Go panics, and pino/bunyan
// levels 50 and 60. Terms are case-sensitive and any one matches. Signal only
// opens issues for lines at ERROR or above, so a stray match is harmless.
// Changing this re-applies every active subscription.
export const awsLogSubscriptionFilterPattern =
  '?ERROR ?Error ?error ?FATAL ?Fatal ?fatal ?CRITICAL ?Critical ?critical ?Exception ?exception ?Traceback ?panic ?"\\"level\\":50" ?"\\"level\\":60"';

export interface AwsLogSubscriptionConfig {
  // Whether Superlog can take the logs in: the ingest token is set. Without
  // it, no new subscriptions are offered or applied, but existing ones can
  // still be removed.
  acceptsLogs: boolean;
  // The account that owns the broker and the destinations.
  destinationAccountId: string;
  destinationName: string;
  principalArn: string;
  // Regions with a destination, in the order regions are offered.
  regions: string[];
}

const roleArnPattern = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u;
const destinationNamePattern = /^[A-Za-z0-9_.-]{1,512}$/u;

// The log streaming settings the infrastructure gives the API, or null when
// this installation has no log destinations. Streaming is offered only when
// the ingest token is set too (`acceptsLogs`): without it, subscriptions would
// send logs the ingest route refuses.
export function awsLogSubscriptionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AwsLogSubscriptionConfig | null {
  const acceptsLogs = Boolean(environment.AWS_CLOUDWATCH_LOGS_INGEST_TOKEN?.trim());
  const principalArn = environment.AWS_LOG_SUBSCRIPTION_PRINCIPAL_ARN?.trim();
  const destinationName = environment.AWS_LOG_DESTINATION_NAME?.trim();
  const listed = (environment.AWS_LOG_DESTINATION_REGIONS ?? "")
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);
  const destinationAccountId = principalArn ? roleArnPattern.exec(principalArn)?.[1] : undefined;
  if (!principalArn || !destinationAccountId || !destinationName || !destinationNamePattern.test(destinationName)) {
    return null;
  }
  const regions = awsRegions.filter((region) => listed.includes(region));
  if (regions.length === 0) return null;
  return { acceptsLogs, destinationAccountId, destinationName, principalArn, regions };
}

// The broker a new or updated stack should trust, when streaming is offered.
export function awsLogSubscriptionPrincipalArnForStacks(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = awsLogSubscriptionConfig(environment);
  return config?.acceptsLogs ? config.principalArn : null;
}

export function awsLogSubscriptionRoleArn(accountId: string): string {
  return `arn:aws:iam::${awsAccountIdSchema.parse(accountId)}:role/${AWS_LOG_SUBSCRIPTION_ROLE_NAME}`;
}

export function awsLogDestinationArn(config: AwsLogSubscriptionConfig, region: string): string {
  return `arn:aws:logs:${region}:${config.destinationAccountId}:destination:${config.destinationName}`;
}

// The account-level policy Superlog creates in a region. Superlog deletes
// only policies with this name, and ingest reads the region back from it.
export function awsLogSubscriptionPolicyName(region: string): string {
  return `superlog-${region}`;
}

export function regionFromAwsLogSubscriptionPolicyName(name: string): string | null {
  const region = /^superlog-([a-z0-9-]+)$/u.exec(name)?.[1];
  return region && isOfferedAwsRegion(region) ? region : null;
}

export interface AwsTemporaryCredentials {
  accessKeyId: string;
  expiration: Date;
  secretAccessKey: string;
  sessionToken: string;
}

function temporaryCredentials(credentials: Credentials | undefined, stage: string): AwsTemporaryCredentials {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
    throw new Error(`AWS did not return credentials while assuming the ${stage} role`);
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    expiration: credentials.Expiration,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

// AWS refused to let the broker assume the customer's role: the stack
// predates the role, it was removed, or its trust does not match. Other
// failures, such as throttling, are passed through and retried.
export const awsLogSubscriptionRoleName = AWS_LOG_SUBSCRIPTION_ROLE_NAME;

export class AwsLogSubscriptionRoleUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Superlog could not assume ${awsLogSubscriptionRoleName} in this AWS account. Update the Superlog stack to the latest template.`,
      { cause },
    );
  }
}

type StsFactory = (credentials?: AwsTemporaryCredentials) => Pick<STSClient, "send">;

const defaultSts: StsFactory = (credentials) =>
  new STSClient({ region: AWS_MCP_SIGNING_REGION, ...(credentials ? { credentials } : {}) });

export async function assumeAwsLogSubscriptionRole(
  connection: Pick<AwsConnectionCredentials, "accountId" | "externalId">,
  options: { config: AwsLogSubscriptionConfig; sessionName?: string; sts?: StsFactory },
): Promise<AwsTemporaryCredentials> {
  const sts = options.sts ?? defaultSts;
  const suffix = (options.sessionName ?? randomBytes(8).toString("hex")).replace(/[^A-Za-z0-9+=,.@_-]/gu, "-").slice(0, 40);
  const broker = temporaryCredentials((await sts().send(new AssumeRoleCommand({
    DurationSeconds: 900,
    RoleArn: options.config.principalArn,
    RoleSessionName: `superlog-logs-broker-${suffix}`,
  }))).Credentials, "log subscription broker");
  try {
    const customer = await sts(broker).send(new AssumeRoleCommand({
      DurationSeconds: 900,
      ExternalId: connection.externalId,
      RoleArn: awsLogSubscriptionRoleArn(connection.accountId),
      RoleSessionName: `superlog-logs-${suffix}`,
    }));
    return temporaryCredentials(customer.Credentials, "log subscription");
  } catch (error) {
    if (isAccessDenied(error)) throw new AwsLogSubscriptionRoleUnavailableError(error);
    throw error;
  }
}

function isAccessDenied(error: unknown): boolean {
  const name = errorName(error);
  return name === "AccessDenied" || name === "AccessDeniedException" || /not authorized/iu.test(errorMessage(error));
}

export type LogsClientFactory = (region: string, credentials?: AwsTemporaryCredentials) => Pick<CloudWatchLogsClient, "send">;

export const defaultLogsClient: LogsClientFactory = (region, credentials) =>
  new CloudWatchLogsClient({ region, ...(credentials ? { credentials } : {}) });

// Creates or updates the region's policy in the customer's account.
export async function putAwsLogSubscription(input: {
  config: AwsLogSubscriptionConfig;
  credentials: AwsTemporaryCredentials;
  filterPattern: string;
  logs?: LogsClientFactory;
  region: string;
}): Promise<void> {
  const logs = (input.logs ?? defaultLogsClient)(input.region, input.credentials);
  await logs.send(new PutAccountPolicyCommand({
    policyDocument: JSON.stringify({
      DestinationArn: awsLogDestinationArn(input.config, input.region),
      Distribution: "Random",
      FilterPattern: input.filterPattern,
    }),
    policyName: awsLogSubscriptionPolicyName(input.region),
    policyType: "SUBSCRIPTION_FILTER_POLICY",
    scope: "ALL",
  }));
}

// Deletes the region's policy. A policy that is already gone counts as
// deleted.
export async function deleteAwsLogSubscription(input: {
  credentials: AwsTemporaryCredentials;
  logs?: LogsClientFactory;
  region: string;
}): Promise<void> {
  const logs = (input.logs ?? defaultLogsClient)(input.region, input.credentials);
  try {
    await logs.send(new DeleteAccountPolicyCommand({
      policyName: awsLogSubscriptionPolicyName(input.region),
      policyType: "SUBSCRIPTION_FILTER_POLICY",
    }));
  } catch (error) {
    if (errorName(error) !== "ResourceNotFoundException") throw error;
  }
}

// The access policy of Superlog's destination in a region: only these AWS
// accounts may subscribe to it. With none, only Superlog's own account is
// listed, since the policy needs a principal. An account-level subscription
// policy from another account needs logs:PutAccountPolicy as well as
// logs:PutSubscriptionFilter; without it, CloudWatch Logs refuses the
// customer's PutAccountPolicy call.
export function awsLogDestinationPolicy(config: AwsLogSubscriptionConfig, region: string, accountIds: string[]): string {
  const principals = [...new Set(accountIds.filter((id) => awsAccountIdSchema.safeParse(id).success))].sort();
  return JSON.stringify({
    Statement: [{
      Action: ["logs:PutSubscriptionFilter", "logs:PutAccountPolicy"],
      Effect: "Allow",
      Principal: { AWS: principals.length > 0 ? principals : [config.destinationAccountId] },
      Resource: awsLogDestinationArn(config, region),
      Sid: "SuperlogWorkspaces",
    }],
    Version: "2012-10-17",
  });
}

// Sets the destination's access policy, with the API's own credentials.
export async function putAwsLogDestinationPolicy(input: {
  accountIds: string[];
  config: AwsLogSubscriptionConfig;
  logs?: LogsClientFactory;
  region: string;
}): Promise<void> {
  const logs = (input.logs ?? defaultLogsClient)(input.region);
  await logs.send(new PutDestinationPolicyCommand({
    accessPolicy: awsLogDestinationPolicy(input.config, input.region, input.accountIds),
    destinationName: input.config.destinationName,
  }));
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AwsLogSubscriptionProblem =
  | "access_denied"
  | "destination_unavailable"
  | "role_missing"
  | "subscription_exists"
  | "unknown";

// A message a workspace admin can act on, for an error while applying or
// removing a subscription. `destinationArn` is Superlog's destination in the
// region: a refusal that names it is Superlog's to fix, not the customer's.
export function describeAwsLogSubscriptionError(
  error: unknown,
  region: string,
  destinationArn?: string,
): { message: string; problem: AwsLogSubscriptionProblem } {
  if (error instanceof AwsLogSubscriptionRoleUnavailableError) {
    return { message: error.message, problem: "role_missing" };
  }
  const name = errorName(error);
  const text = errorMessage(error);
  if (name === "LimitExceededException" || /already (?:has|exists)|maximum number|only one/iu.test(text)) {
    return {
      message: `${region} already has an account-level log subscription, and AWS allows one per account and region. Find out what sends logs through it before you change it: choose another region, or remove that policy only if nothing depends on it.`,
      problem: "subscription_exists",
    };
  }
  if (destinationArn && text.includes(destinationArn)) {
    return { message: `Superlog's log destination in ${region} did not accept this account yet. Superlog retries on its own.`, problem: "destination_unavailable" };
  }
  if (isAccessDenied(error)) {
    return {
      message: `AWS denied the change in ${region}. A service control policy or permission boundary may block CloudWatch Logs account policies there.`,
      problem: "access_denied",
    };
  }
  return { message: `AWS returned an error in ${region}: ${text}`.slice(0, 500), problem: "unknown" };
}
