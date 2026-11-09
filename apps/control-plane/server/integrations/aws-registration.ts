import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import {
  claimIntegrationRegistration,
  deleteIntegrationAccount,
  getIntegrationAccountByRegistration,
  getIntegrationAccountMergedFromRegistration,
  getOrganizationIntegrationAccount,
  getPendingIntegrationRegistration,
  markIntegrationAccountConnected,
  upsertIntegrationAccount,
} from "../../../../packages/core/src/db/integrations.js";
import {
  awsCloudFormationQuickCreateUrl,
  awsConnectionCredentialsSchema,
  awsIntegrationPrincipalArn,
  awsInvestigationRoleArn,
  awsParameterizedCloudFormationTemplate,
  createAwsCloudFormationTemplateUrl,
  createAwsExternalId,
  verifyAwsInvestigationRole,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  AWS_REGISTRATION_EXPIRED_REASON,
  AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
  awsRegistrationCredentialsSchema,
  awsRegistrationExternalAccountId,
  awsRegistrationHash,
  awsRegistrationPhysicalResourceId,
  awsRegistrationTopicArn,
  type CloudFormationCustomResourceRequest,
  cloudFormationCustomResourceRequestSchema,
  type CloudFormationResponse,
  cloudFormationStackAccountId,
  confirmSnsSubscription,
  isAcceptedAwsRegistrationTopic,
  isCloudFormationResponseUrl,
  sendCloudFormationResponse,
  snsMessageSchema,
  verifySnsMessageSignature,
} from "../../../../packages/core/src/integrations/aws-registration.js";
import { getActiveTenant } from "../tenant.js";
import {
  type AwsLogStream,
  commitAwsLogStream,
  prepareAwsLogStream,
  readAwsLogStream,
} from "./aws-log-stream.js";

export const AWS_REGISTRATION_UNAVAILABLE_ERROR =
  "One-click AWS setup is not available in this region";
const REGISTRATION_DISPLAY_NAME = "AWS · Waiting for CloudFormation";
const ALREADY_USED_REASON =
  "This Superlog setup link was already used for another AWS account. Start again from Superlog.";
const FAILED_REASON =
  "Superlog could not record this AWS account. Start again from Superlog.";
const VERIFY_INTERVAL_MS = 5_000;

function logRegistration(fields: Record<string, unknown>): void {
  const log = fields.outcome === "error" ? console.error : console.info;
  log(JSON.stringify({ event: "aws_registration", ...fields }));
}

function readStoredCredentials(encryptedCredentials: string | null | undefined): unknown {
  if (!encryptedCredentials) return null;
  try {
    return decryptCredentials<Record<string, unknown>>(encryptedCredentials);
  } catch {
    return null;
  }
}

function readCredentials<T extends z.ZodType>(
  schema: T,
  encryptedCredentials: string | null | undefined,
): z.infer<T> | null {
  if (!encryptedCredentials) return null;
  try {
    const parsed = schema.safeParse(
      decryptCredentials<Record<string, unknown>>(encryptedCredentials),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type AwsRegistrationStart =
  | { available: false }
  | {
      accountId: string;
      available: true;
      cloudFormationUrl: string | null;
      streamsLogs: boolean;
      template: string;
    };

// Prepares a setup link that does not need the customer's account ID. The
// stack reports the account back through the registration topic. With a
// region, the stack opens there and also streams that region's CloudWatch
// Logs to the workspace.
export async function startAwsRegistration(
  organizationId: string,
  options: { region?: string; userId?: string } = {},
): Promise<AwsRegistrationStart> {
  const registrationTopicArn = awsRegistrationTopicArn();
  if (!registrationTopicArn) return { available: false };
  const principalArn = awsIntegrationPrincipalArn();

  const pending = await getPendingIntegrationRegistration({
    externalAccountIdPrefix: AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
    organizationId,
    provider: "aws",
  });
  const pendingStored = readStoredCredentials(pending?.encryptedCredentials);
  const pendingCredentials = awsRegistrationCredentialsSchema.safeParse(pendingStored);
  let accountId: string | null = null;
  let externalId: string;
  let previousStream: AwsLogStream | null = null;
  if (pending && pendingCredentials.success) {
    accountId = pending.id;
    externalId = pendingCredentials.data.externalId;
    previousStream = readAwsLogStream(pendingStored);
  } else {
    // An unreadable placeholder can never be claimed; replace it so it does
    // not shadow the new one.
    if (pending) {
      await deleteIntegrationAccount({
        integrationAccountId: pending.id,
        organizationId,
        provider: "aws",
      });
    }
    externalId = createAwsExternalId();
  }

  // Only a quick-create link carries the ingest key, so without one there is
  // nothing to stream.
  const templateUrl = await createAwsCloudFormationTemplateUrl();
  const prepared = templateUrl && options.region && options.userId
    ? await prepareAwsLogStream({
        organizationId,
        previous: previousStream,
        region: options.region,
        userId: options.userId,
      })
    : null;
  // A new placeholder, or a new ingest key for an open one, is saved before
  // the link goes out, so the next launch finds the same key. Without a new
  // key, an open placeholder keeps the one it has.
  const openAccountId = accountId;
  accountId = await commitAwsLogStream({
    organizationId,
    prepared,
    region: options.region,
    saveConnection: async () => {
      if (openAccountId && !prepared?.created) return openAccountId;
      const logStream = prepared?.stream ?? previousStream;
      return upsertIntegrationAccount({
        organizationId,
        provider: "aws",
        externalAccountId: awsRegistrationExternalAccountId(externalId),
        displayName: REGISTRATION_DISPLAY_NAME,
        encryptedCredentials: encryptCredentials({
          externalId,
          registration: true,
          ...(logStream ? { logStream } : {}),
        }),
        credentialKeyVersion: 1,
        metadata: {
          permissionPolicy: "AIOpsAssistantPolicy",
          registrationHash: awsRegistrationHash(externalId),
          roleName: "ResponderInvestigationRole",
        },
        status: "pending",
      });
    },
    userId: options.userId ?? "",
  });

  return {
    accountId,
    available: true,
    cloudFormationUrl: templateUrl
      ? awsCloudFormationQuickCreateUrl({
          externalId,
          principalArn,
          region: options.region,
          registrationTopicArn,
          stream: prepared?.parameters,
          templateUrl,
        })
      : null,
    streamsLogs: prepared !== null,
    // The download registers from any region, but it carries no ingest key:
    // a key in a file outlives the setup.
    template: awsParameterizedCloudFormationTemplate({
      externalId,
      principalArn,
      registrationTopicArn,
    }),
  };
}

async function registerAwsAccount(
  request: CloudFormationCustomResourceRequest,
  awsAccountId: string | null,
  physicalResourceId: string,
): Promise<CloudFormationResponse> {
  if (request.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId, Status: "SUCCESS" };
  }
  const failed = (reason: string): CloudFormationResponse => ({
    PhysicalResourceId: physicalResourceId,
    Reason: reason,
    Status: "FAILED",
  });
  if (!awsAccountId) return failed(FAILED_REASON);
  const externalId = z
    .string()
    .min(32)
    .max(256)
    .safeParse(request.ResourceProperties?.ExternalId);
  if (!externalId.success) return failed(AWS_REGISTRATION_EXPIRED_REASON);
  const roleArn = awsInvestigationRoleArn(awsAccountId);
  const reportedRoleArn = request.ResourceProperties?.RoleArn;
  if (reportedRoleArn !== undefined && reportedRoleArn !== roleArn) {
    return failed(FAILED_REASON);
  }

  const registrationHash = awsRegistrationHash(externalId.data);
  const account = await getIntegrationAccountByRegistration({
    externalAccountId: awsRegistrationExternalAccountId(externalId.data),
    provider: "aws",
    registrationHash,
  });
  if (!account) {
    logRegistration({ awsAccountId, outcome: "unknown_external_id" });
    return failed(AWS_REGISTRATION_EXPIRED_REASON);
  }

  const success: CloudFormationResponse = {
    Data: { RoleArn: roleArn },
    PhysicalResourceId: awsRegistrationPhysicalResourceId(awsAccountId),
    Status: "SUCCESS",
  };
  // SNS can deliver a request more than once, and stack updates send it
  // again. A row that already holds these credentials needs no change, and
  // rewriting it would undo a finished connection.
  const stored = readCredentials(
    awsConnectionCredentialsSchema,
    account.encryptedCredentials,
  );
  if (account.externalAccountId === awsAccountId && stored?.externalId === externalId.data) {
    return success;
  }

  const result = await claimIntegrationRegistration({
    displayName: `AWS · ${awsAccountId}`,
    encryptedCredentials: encryptCredentials({
      accountId: awsAccountId,
      externalId: externalId.data,
      roleArn,
    }),
    externalAccountId: awsAccountId,
    externalAccountIdPrefix: AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
    organizationId: account.organizationId,
    provider: "aws",
    registrationAccountId: account.id,
    registrationHash,
  });
  if (!result) return failed(AWS_REGISTRATION_EXPIRED_REASON);
  if (result.status === "already_claimed") {
    logRegistration({
      awsAccountId,
      organizationId: account.organizationId,
      outcome: "already_claimed",
    });
    return failed(ALREADY_USED_REASON);
  }
  logRegistration({
    awsAccountId,
    integrationAccountId: result.integrationAccountId,
    merged: result.merged,
    organizationId: account.organizationId,
    outcome: "registered",
  });
  return success;
}

// Reports false only when the CloudFormation answer did not upload. SNS
// retries a non-2xx delivery, and that is the one failure a retry can fix.
async function handleCloudFormationRequest(message: string): Promise<boolean> {
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    body = null;
  }
  const parsed = cloudFormationCustomResourceRequestSchema.safeParse(body);
  if (!parsed.success) {
    logRegistration({ outcome: "invalid_request" });
    return true;
  }
  const request = parsed.data;
  if (!isCloudFormationResponseUrl(request.ResponseURL)) {
    logRegistration({ outcome: "invalid_response_url" });
    return true;
  }
  const awsAccountId = cloudFormationStackAccountId(request.StackId);
  const physicalResourceId =
    request.PhysicalResourceId ??
    awsRegistrationPhysicalResourceId(awsAccountId ?? "unknown");

  let response: CloudFormationResponse;
  try {
    response = await registerAwsAccount(request, awsAccountId, physicalResourceId);
  } catch (error) {
    logRegistration({
      awsAccountId,
      error: error instanceof Error ? error.message : "Unknown error",
      outcome: "error",
      stage: "register",
    });
    response = {
      PhysicalResourceId: physicalResourceId,
      Reason: FAILED_REASON,
      Status: "FAILED",
    };
  }
  try {
    await sendCloudFormationResponse(request, response);
  } catch (error) {
    logRegistration({
      awsAccountId,
      error: error instanceof Error ? error.message : "Unknown error",
      outcome: "error",
      stage: "respond",
    });
    return false;
  }
  return true;
}

const lastVerificationAttempts = new Map<string, number>();

// Each poll may try AssumeRole, but no more than once per interval per
// account in this process, however many tabs poll it.
function claimVerificationAttempt(accountId: string, now = Date.now()): boolean {
  const last = lastVerificationAttempts.get(accountId);
  if (last !== undefined && now - last < VERIFY_INTERVAL_MS) return false;
  if (lastVerificationAttempts.size > 1_000) {
    for (const [id, attemptedAt] of lastVerificationAttempts) {
      if (now - attemptedAt >= VERIFY_INTERVAL_MS) lastVerificationAttempts.delete(id);
    }
  }
  lastVerificationAttempts.set(accountId, now);
  return true;
}

export function resetAwsVerificationAttempts(): void {
  lastVerificationAttempts.clear();
}

export const awsRegistrationRoutes = new Hono()
  // SNS delivers here without a session. The signature, topic, and later
  // AssumeRole decide what to trust.
  .post("/registrations", async (context) => {
    let body: unknown;
    try {
      body = JSON.parse(await context.req.text());
    } catch {
      return context.json({ error: "Invalid SNS message" }, 400);
    }
    const parsed = snsMessageSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "Invalid SNS message" }, 400);
    }
    const message = parsed.data;
    if (!isAcceptedAwsRegistrationTopic(message.TopicArn)) {
      logRegistration({ outcome: "unknown_topic" });
      return context.json({ error: "Forbidden" }, 403);
    }
    if (!(await verifySnsMessageSignature(message))) {
      logRegistration({ outcome: "invalid_signature" });
      return context.json({ error: "Forbidden" }, 403);
    }

    if (message.Type === "SubscriptionConfirmation") {
      try {
        await confirmSnsSubscription(message.SubscribeURL ?? "");
      } catch (error) {
        logRegistration({
          error: error instanceof Error ? error.message : "Unknown error",
          outcome: "error",
          stage: "subscribe",
        });
        return context.json({ error: "Unable to confirm the subscription" }, 502);
      }
      logRegistration({ outcome: "subscribed" });
      return context.body(null, 200);
    }
    if (message.Type === "UnsubscribeConfirmation") {
      return context.body(null, 200);
    }
    return (await handleCloudFormationRequest(message.Message))
      ? context.body(null, 200)
      : context.json({ error: "Unable to answer CloudFormation" }, 502);
  })
  .get("/setup/:integrationAccountId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const integrationAccountId = z.uuid().safeParse(
      context.req.param("integrationAccountId"),
    );
    if (!integrationAccountId.success) {
      return context.json({ error: "The AWS setup session is invalid" }, 400);
    }
    const lookup = {
      organizationId: tenant.organizationId,
      provider: "aws" as const,
    };
    const account =
      (await getOrganizationIntegrationAccount({
        ...lookup,
        integrationAccountId: integrationAccountId.data,
      })) ??
      (await getIntegrationAccountMergedFromRegistration({
        ...lookup,
        registrationAccountId: integrationAccountId.data,
      }));
    if (!account) {
      return context.json({ error: "Start the AWS connection again" }, 404);
    }
    const credentials = readCredentials(
      awsConnectionCredentialsSchema,
      account.encryptedCredentials,
    );
    if (!credentials || !account.encryptedCredentials) {
      return context.json({ status: "waiting" as const });
    }
    const known = {
      awsAccountId: credentials.accountId,
      roleArn: credentials.roleArn,
    };
    if (account.status === "connected") {
      return context.json({ status: "connected" as const, ...known });
    }
    if (!claimVerificationAttempt(account.id)) {
      return context.json({ status: "verifying" as const, ...known });
    }
    try {
      await verifyAwsInvestigationRole(credentials);
    } catch (error) {
      // IAM takes a few seconds to make a new role assumable, so keep
      // polling. A failure that lasts points at the role's trust policy.
      logRegistration({
        awsAccountId: credentials.accountId,
        error: error instanceof Error ? error.message : "Unknown error",
        integrationAccountId: account.id,
        outcome: "not_assumable_yet",
        stage: "verify",
      });
      return context.json({ status: "verifying" as const, ...known });
    }
    const connected = await markIntegrationAccountConnected({
      ...lookup,
      encryptedCredentials: account.encryptedCredentials,
      integrationAccountId: account.id,
    });
    if (connected) {
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: account.id,
          provider: "aws",
          setup: "registration",
        },
      });
      return context.json({ status: "connected" as const, ...known });
    }
    // Another poll connected it first, or the credentials changed while this
    // one verified the old ones.
    const current = await getOrganizationIntegrationAccount({
      ...lookup,
      integrationAccountId: account.id,
    });
    return context.json({
      status:
        current?.status === "connected" &&
        current.encryptedCredentials === account.encryptedCredentials
          ? ("connected" as const)
          : ("verifying" as const),
      ...known,
    });
  });
