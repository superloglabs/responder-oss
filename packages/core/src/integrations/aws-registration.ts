import { createHash, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  awsAccountIdSchema,
  isAwsCommercialRegion,
  parseSnsTopicArn,
} from "./aws.js";

// One-click AWS setup: the CloudFormation stack's custom resource publishes to
// an SNS topic, SNS delivers to Responder, and Responder learns which account
// ran the stack. Anyone can publish to the topic, so every field here is
// untrusted until the signature checks out, and even then the connection is
// only trusted once AssumeRole into the reported account succeeds.

export const AWS_REGISTRATION_TOPIC_NAME = "ResponderAwsRegistration";
export const AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX = "registration:";
export const AWS_REGISTRATION_EXPIRED_REASON =
  "This Superlog setup link expired. Start again from Superlog.";

const NETWORK_TIMEOUT_MS = 10_000;
const MAX_CACHED_SIGNING_KEYS = 32;

export const awsRegistrationCredentialsSchema = z.object({
  externalId: z.string().min(32).max(256),
  registration: z.literal(true),
});

export function awsRegistrationHash(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex");
}

export function awsRegistrationExternalAccountId(externalId: string): string {
  return `${AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX}${awsRegistrationHash(externalId)}`;
}

// The configured topic, or null when this deployment does not offer
// one-click setup.
export function awsRegistrationTopicArn(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const topicArn = environment.AWS_INTEGRATION_REGISTRATION_TOPIC_ARN?.trim();
  return topicArn && parseSnsTopicArn(topicArn) ? topicArn : null;
}

export function isAcceptedAwsRegistrationTopic(
  topicArn: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = environment.AWS_INTEGRATION_REGISTRATION_TOPIC_ARN?.trim();
  if (configured) return topicArn === configured && parseSnsTopicArn(configured) !== null;
  // During rollout the subscription can confirm before the API tasks learn
  // the topic ARN. Accept only the named topic in the broker's own account.
  const brokerAccountId = /^arn:aws:iam::(\d{12}):role\//.exec(
    environment.AWS_INTEGRATION_PRINCIPAL_ARN?.trim() ?? "",
  )?.[1];
  const topic = parseSnsTopicArn(topicArn);
  return Boolean(
    brokerAccountId &&
      topic &&
      topic.accountId === brokerAccountId &&
      topic.name === AWS_REGISTRATION_TOPIC_NAME,
  );
}

function isPlainHttpsUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === ""
  );
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isSnsServiceUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !isPlainHttpsUrl(url)) return false;
  const region = /^sns\.([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname)?.[1];
  return region !== undefined && isAwsCommercialRegion(region);
}

export function isSnsSigningCertificateUrl(value: string): boolean {
  return isSnsServiceUrl(value) && new URL(value).pathname.endsWith(".pem");
}

export function isCloudFormationResponseUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !isPlainHttpsUrl(url)) return false;
  const host = url.hostname;
  if (host === "s3.amazonaws.com") return true;
  if (/^[a-z0-9][a-z0-9.-]*\.s3\.amazonaws\.com$/.test(host)) return true;
  // Older regions also use the dash form, s3-<region>.amazonaws.com.
  const region = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(
    host,
  )?.[1];
  return region !== undefined && isAwsCommercialRegion(region);
}

export const snsMessageSchema = z.object({
  Type: z.enum([
    "Notification",
    "SubscriptionConfirmation",
    "UnsubscribeConfirmation",
  ]),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Message: z.string(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  Subject: z.string().nullish(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
});

export type SnsMessage = z.infer<typeof snsMessageSchema>;

// The string SNS signs, per
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
export function snsSigningString(message: SnsMessage): string | null {
  const fields: Array<[string, string | null | undefined]> =
    message.Type === "Notification"
      ? [
          ["Message", message.Message],
          ["MessageId", message.MessageId],
          ...(typeof message.Subject === "string"
            ? [["Subject", message.Subject] as [string, string]]
            : []),
          ["Timestamp", message.Timestamp],
          ["TopicArn", message.TopicArn],
          ["Type", message.Type],
        ]
      : [
          ["Message", message.Message],
          ["MessageId", message.MessageId],
          ["SubscribeURL", message.SubscribeURL],
          ["Timestamp", message.Timestamp],
          ["Token", message.Token],
          ["TopicArn", message.TopicArn],
          ["Type", message.Type],
        ];
  if (fields.some(([, value]) => typeof value !== "string")) return null;
  return fields.map(([key, value]) => `${key}\n${value}\n`).join("");
}

export type SnsSigningKeyLoader = (certificateUrl: string) => Promise<KeyObject>;

const signingKeys = new Map<string, Promise<KeyObject>>();

export function clearSnsSigningKeyCache(): void {
  signingKeys.clear();
}

// Fetches the signing certificate once per URL. Only URLs already checked by
// isSnsSigningCertificateUrl reach here, so the cache holds AWS keys only.
export function fetchSnsSigningKey(
  certificateUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyObject> {
  const cached = signingKeys.get(certificateUrl);
  if (cached) return cached;
  const loading = (async () => {
    const response = await fetchImpl(certificateUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`SNS signing certificate request failed with ${response.status}`);
    }
    const key = createPublicKey(await response.text());
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("SNS signing certificate is not an RSA key");
    }
    return key;
  })();
  if (signingKeys.size >= MAX_CACHED_SIGNING_KEYS) {
    const oldest = signingKeys.keys().next().value;
    if (oldest !== undefined) signingKeys.delete(oldest);
  }
  signingKeys.set(certificateUrl, loading);
  loading.catch(() => {
    if (signingKeys.get(certificateUrl) === loading) signingKeys.delete(certificateUrl);
  });
  return loading;
}

export async function verifySnsMessageSignature(
  message: SnsMessage,
  loadSigningKey: SnsSigningKeyLoader = (url) => fetchSnsSigningKey(url),
): Promise<boolean> {
  if (!isSnsSigningCertificateUrl(message.SigningCertURL)) return false;
  const signingString = snsSigningString(message);
  if (signingString === null) return false;
  let key: KeyObject;
  try {
    key = await loadSigningKey(message.SigningCertURL);
  } catch {
    return false;
  }
  try {
    return createVerify(message.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
      .update(signingString, "utf8")
      .verify(key, message.Signature, "base64");
  } catch {
    return false;
  }
}

export async function confirmSnsSubscription(
  subscribeUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isSnsServiceUrl(subscribeUrl)) {
    throw new Error("SNS subscription URL is not an SNS endpoint");
  }
  const response = await fetchImpl(subscribeUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SNS subscription confirmation failed with ${response.status}`);
  }
}

export const cloudFormationCustomResourceRequestSchema = z.object({
  RequestType: z.enum(["Create", "Update", "Delete"]),
  ResponseURL: z.string().min(1),
  StackId: z.string().min(1),
  RequestId: z.string().min(1),
  LogicalResourceId: z.string().min(1),
  PhysicalResourceId: z.string().optional(),
  ResourceType: z.string().optional(),
  ResourceProperties: z
    .looseObject({
      ExternalId: z.string().optional(),
      RoleArn: z.string().optional(),
    })
    .optional(),
});

export type CloudFormationCustomResourceRequest = z.infer<
  typeof cloudFormationCustomResourceRequestSchema
>;

// arn:aws:cloudformation:<region>:<account>:stack/<name>/<id>
export function cloudFormationStackAccountId(stackId: string): string | null {
  const fields = stackId.split(":");
  if (fields[0] !== "arn" || fields[1] !== "aws" || fields[2] !== "cloudformation") {
    return null;
  }
  const accountId = awsAccountIdSchema.safeParse(fields[4]);
  return accountId.success ? accountId.data : null;
}

export function awsRegistrationPhysicalResourceId(accountId: string): string {
  return `responder-registration-${accountId}`;
}

export interface CloudFormationResponse {
  Data?: Record<string, string>;
  PhysicalResourceId: string;
  Reason?: string;
  Status: "FAILED" | "SUCCESS";
}

export async function sendCloudFormationResponse(
  request: CloudFormationCustomResourceRequest,
  response: CloudFormationResponse,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isCloudFormationResponseUrl(request.ResponseURL)) {
    throw new Error("CloudFormation response URL is not an Amazon S3 URL");
  }
  const result = await fetchImpl(request.ResponseURL, {
    body: JSON.stringify({
      Status: response.Status,
      Reason: response.Reason ?? "",
      PhysicalResourceId: response.PhysicalResourceId,
      StackId: request.StackId,
      RequestId: request.RequestId,
      LogicalResourceId: request.LogicalResourceId,
      Data: response.Data ?? {},
    }),
    // The presigned URL was signed without a content type.
    headers: { "content-type": "" },
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!result.ok) {
    throw new Error(`CloudFormation response upload failed with ${result.status}`);
  }
}
