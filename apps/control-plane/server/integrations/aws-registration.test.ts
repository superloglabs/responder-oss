import { createSign, generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  claimIntegrationRegistration,
  getIntegrationAccountByRegistration,
  getIntegrationAccountMergedFromRegistration,
  getOrganizationIntegrationAccount,
  markIntegrationAccountConnected,
} from "../../../../packages/core/src/db/integrations.js";
import { verifyAwsInvestigationRole } from "../../../../packages/core/src/integrations/aws.js";
import {
  awsRegistrationHash,
  clearSnsSigningKeyCache,
  type SnsMessage,
  snsSigningString,
} from "../../../../packages/core/src/integrations/aws-registration.js";
import { getActiveTenant } from "../tenant.js";
import {
  awsRegistrationRoutes,
  resetAwsVerificationAttempts,
} from "./aws-registration.js";

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: vi.fn(),
}));

// Credentials round-trip as readable JSON so assertions can see them.
vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: vi.fn((value: string) => JSON.parse(value.slice("enc:".length))),
  encryptCredentials: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
}));

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  claimIntegrationRegistration: vi.fn(),
  deleteIntegrationAccount: vi.fn(),
  getIntegrationAccountByRegistration: vi.fn(),
  getIntegrationAccountMergedFromRegistration: vi.fn(),
  getOrganizationIntegrationAccount: vi.fn(),
  getPendingIntegrationRegistration: vi.fn(),
  markIntegrationAccountConnected: vi.fn(),
  upsertIntegrationAccount: vi.fn(),
}));

vi.mock("../../../../packages/core/src/integrations/aws.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../packages/core/src/integrations/aws.js")
  >()),
  verifyAwsInvestigationRole: vi.fn(),
}));

vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
}));

const app = new Hono().route("/api/integrations/aws", awsRegistrationRoutes);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const certificateUrl =
  "https://sns.eu-west-3.amazonaws.com/SimpleNotificationService-registration-test.pem";
const topicArn = "arn:aws:sns:eu-west-3:111122223333:ResponderAwsRegistration";
const responseUrl =
  "https://cloudformation-custom-resource-response-euwest3.s3.eu-west-3.amazonaws.com/response?X-Amz-Signature=abc";
const externalId = "responder_abcdefghijklmnopqrstuvwxyz1234567890";
const awsAccountId = "123456789012";
const roleArn = "arn:aws:iam::123456789012:role/ResponderInvestigationRole";
const organizationId = "10000000-0000-4000-8000-000000000000";
const registrationAccountId = "30000000-0000-4000-8000-000000000000";
const existingAccountId = "40000000-0000-4000-8000-000000000000";
const stackId =
  "arn:aws:cloudformation:eu-west-3:123456789012:stack/ResponderInvestigationAccess/0f6c2b70-0000-11ef-0000-0a1b2c3d4e5f";

const tenant = {
  ok: true as const,
  organizationId,
  role: "member",
  user: { email: "test@example.com", id: "20000000-0000-4000-8000-000000000000", name: "Test" },
};

function sign(
  message: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">,
): SnsMessage {
  const unsigned: SnsMessage = {
    ...message,
    Signature: "",
    SignatureVersion: "2",
    SigningCertURL: certificateUrl,
  };
  return {
    ...unsigned,
    Signature: createSign("RSA-SHA256").update(snsSigningString(unsigned)!).sign(privateKey, "base64"),
  };
}

function customResourceNotification(
  overrides: Record<string, unknown> = {},
  properties: Record<string, unknown> = { ExternalId: externalId, RoleArn: roleArn },
): SnsMessage {
  return sign({
    Message: JSON.stringify({
      LogicalResourceId: "ResponderRegistration",
      RequestId: "f2a3a1c8-1111-4222-8333-444455556666",
      RequestType: "Create",
      ResourceProperties: {
        ServiceToken: topicArn,
        ...properties,
      },
      ResourceType: "Custom::ResponderRegistration",
      ResponseURL: responseUrl,
      StackId: stackId,
      ...overrides,
    }),
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    Timestamp: "2026-11-07T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
  });
}

function deliver(message: unknown) {
  return app.request("/api/integrations/aws/registrations", {
    body: JSON.stringify(message),
    headers: { "content-type": "text/plain; charset=UTF-8" },
    method: "POST",
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function cloudFormationAnswers() {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith(responseUrl))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("one-click AWS registration", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_INTEGRATION_REGISTRATION_TOPIC_ARN", topicArn);
    vi.stubEnv(
      "AWS_INTEGRATION_PRINCIPAL_ARN",
      "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    );
    fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === certificateUrl) return new Response(signingPem);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    clearSnsSigningKeyCache();
    resetAwsVerificationAttempts();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("SNS deliveries", () => {
    it("rejects a message with a bad signature", async () => {
      const message = customResourceNotification();
      const forged = customResourceNotification({ StackId: stackId.replace(awsAccountId, "999999999999") });
      const response = await deliver({ ...message, Message: forged.Message });

      expect(response.status).toBe(403);
      expect(getIntegrationAccountByRegistration).not.toHaveBeenCalled();
      expect(cloudFormationAnswers()).toEqual([]);
    });

    it("rejects a message from another topic before fetching its certificate", async () => {
      const response = await deliver(
        sign({
          Message: "{}",
          MessageId: "1",
          Timestamp: "2026-11-07T12:00:00.000Z",
          TopicArn: "arn:aws:sns:eu-west-3:444455556666:ResponderAwsRegistration",
          Type: "Notification",
        }),
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("confirms the topic subscription", async () => {
      const subscribeUrl =
        "https://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc";
      const response = await deliver(
        sign({
          Message: "You have chosen to subscribe",
          MessageId: "1",
          SubscribeURL: subscribeUrl,
          Timestamp: "2026-11-07T12:00:00.000Z",
          Token: "abc",
          TopicArn: topicArn,
          Type: "SubscriptionConfirmation",
        }),
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        subscribeUrl,
        expect.objectContaining({ redirect: "error" }),
      );
    });

    it("does not follow a subscription URL outside SNS", async () => {
      const response = await deliver(
        sign({
          Message: "You have chosen to subscribe",
          MessageId: "1",
          SubscribeURL: "https://attacker.example/confirm",
          Timestamp: "2026-11-07T12:00:00.000Z",
          Token: "abc",
          TopicArn: topicArn,
          Type: "SubscriptionConfirmation",
        }),
      );

      expect(response.status).toBe(502);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([certificateUrl]);
    });
  });

  describe("CloudFormation requests", () => {
    it("records the account that ran the stack", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue({
        encryptedCredentials: `enc:${JSON.stringify({ externalId, registration: true })}`,
        externalAccountId: `registration:${awsRegistrationHash(externalId)}`,
        id: registrationAccountId,
        organizationId,
        status: "pending",
      });
      vi.mocked(claimIntegrationRegistration).mockResolvedValue({
        integrationAccountId: registrationAccountId,
        merged: false,
      });

      const response = await deliver(customResourceNotification());

      expect(response.status).toBe(200);
      expect(getIntegrationAccountByRegistration).toHaveBeenCalledWith({
        externalAccountId: `registration:${awsRegistrationHash(externalId)}`,
        provider: "aws",
        registrationHash: awsRegistrationHash(externalId),
      });
      expect(claimIntegrationRegistration).toHaveBeenCalledWith({
        displayName: "AWS · 123456789012",
        encryptedCredentials: `enc:${JSON.stringify({ accountId: awsAccountId, externalId, roleArn })}`,
        externalAccountId: awsAccountId,
        organizationId,
        provider: "aws",
        registrationAccountId,
        registrationHash: awsRegistrationHash(externalId),
      });
      expect(cloudFormationAnswers()).toEqual([
        {
          Data: { RoleArn: roleArn },
          LogicalResourceId: "ResponderRegistration",
          PhysicalResourceId: "responder-registration-123456789012",
          Reason: "",
          RequestId: "f2a3a1c8-1111-4222-8333-444455556666",
          StackId: stackId,
          Status: "SUCCESS",
        },
      ]);
      const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === responseUrl)!;
      expect((init as RequestInit).method).toBe("PUT");
      expect((init as RequestInit).headers).toEqual({ "content-type": "" });
    });

    it("moves the credentials onto the organization's existing row for the account", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue({
        encryptedCredentials: `enc:${JSON.stringify({ externalId, registration: true })}`,
        externalAccountId: `registration:${awsRegistrationHash(externalId)}`,
        id: registrationAccountId,
        organizationId,
        status: "pending",
      });
      vi.mocked(claimIntegrationRegistration).mockResolvedValue({
        integrationAccountId: existingAccountId,
        merged: true,
      });

      const response = await deliver(customResourceNotification());

      expect(response.status).toBe(200);
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({ Status: "SUCCESS" }),
      ]);
    });

    it("fails the stack for an unknown external ID", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue(null);

      const response = await deliver(customResourceNotification());

      expect(response.status).toBe(200);
      expect(claimIntegrationRegistration).not.toHaveBeenCalled();
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({
          PhysicalResourceId: "responder-registration-123456789012",
          Reason: "This Superlog setup link expired. Start again from Superlog.",
          Status: "FAILED",
        }),
      ]);
    });

    it("answers a repeated delivery without rewriting a finished connection", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue({
        encryptedCredentials: `enc:${JSON.stringify({ accountId: awsAccountId, externalId, roleArn })}`,
        externalAccountId: awsAccountId,
        id: registrationAccountId,
        organizationId,
        status: "connected",
      });

      const response = await deliver(
        customResourceNotification({
          PhysicalResourceId: "responder-registration-123456789012",
          RequestType: "Update",
        }),
      );

      expect(response.status).toBe(200);
      expect(claimIntegrationRegistration).not.toHaveBeenCalled();
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({ Status: "SUCCESS" }),
      ]);
    });

    it("refuses a setup link already used for another account", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue({
        encryptedCredentials: `enc:${JSON.stringify({
          accountId: "999999999999",
          externalId,
          roleArn: "arn:aws:iam::999999999999:role/ResponderInvestigationRole",
        })}`,
        externalAccountId: "999999999999",
        id: registrationAccountId,
        organizationId,
        status: "connected",
      });

      await deliver(customResourceNotification());

      expect(claimIntegrationRegistration).not.toHaveBeenCalled();
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({ Status: "FAILED" }),
      ]);
    });

    it("acknowledges a delete without touching integrations", async () => {
      const response = await deliver(
        customResourceNotification({
          PhysicalResourceId: "responder-registration-123456789012",
          RequestType: "Delete",
        }),
      );

      expect(response.status).toBe(200);
      expect(getIntegrationAccountByRegistration).not.toHaveBeenCalled();
      expect(claimIntegrationRegistration).not.toHaveBeenCalled();
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({
          PhysicalResourceId: "responder-registration-123456789012",
          Status: "SUCCESS",
        }),
      ]);
    });

    it("never sends a response outside Amazon S3", async () => {
      const response = await deliver(
        customResourceNotification({ ResponseURL: "https://attacker.example/collect" }),
      );

      expect(response.status).toBe(200);
      expect(getIntegrationAccountByRegistration).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([certificateUrl]);
    });

    it("fails the stack when recording the account fails", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockRejectedValue(
        new Error("database unavailable"),
      );

      const response = await deliver(customResourceNotification());

      expect(response.status).toBe(200);
      expect(cloudFormationAnswers()).toEqual([
        expect.objectContaining({ Status: "FAILED" }),
      ]);
    });

    it("asks SNS to retry when CloudFormation's answer does not upload", async () => {
      vi.mocked(getIntegrationAccountByRegistration).mockResolvedValue(null);
      fetchMock.mockImplementation(async (url: string | URL) =>
        String(url) === certificateUrl
          ? new Response(signingPem)
          : new Response(null, { status: 503 }),
      );

      const response = await deliver(customResourceNotification());

      expect(response.status).toBe(502);
    });
  });

  describe("setup polling", () => {
    const poll = () =>
      app.request(`/api/integrations/aws/setup/${registrationAccountId}`);
    const connectedCredentials = `enc:${JSON.stringify({ accountId: awsAccountId, externalId, roleArn })}`;

    it("waits until the stack reports its account", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
        encryptedCredentials: `enc:${JSON.stringify({ externalId, registration: true })}`,
        id: registrationAccountId,
        metadata: {},
        status: "pending",
      });

      const response = await poll();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "waiting" });
      expect(getOrganizationIntegrationAccount).toHaveBeenCalledWith({
        integrationAccountId: registrationAccountId,
        organizationId,
        provider: "aws",
      });
      expect(verifyAwsInvestigationRole).not.toHaveBeenCalled();
    });

    it("keeps verifying while the role cannot be assumed, at most once per interval", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
        encryptedCredentials: connectedCredentials,
        id: registrationAccountId,
        metadata: {},
        status: "pending",
      });
      vi.mocked(verifyAwsInvestigationRole).mockRejectedValue(new Error("AccessDenied"));

      const first = await poll();
      const second = await poll();

      await expect(first.json()).resolves.toEqual({
        awsAccountId,
        roleArn,
        status: "verifying",
      });
      await expect(second.json()).resolves.toEqual({
        awsAccountId,
        roleArn,
        status: "verifying",
      });
      expect(verifyAwsInvestigationRole).toHaveBeenCalledTimes(1);
      expect(markIntegrationAccountConnected).not.toHaveBeenCalled();
    });

    it("connects once the role can be assumed and announces it once", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
        encryptedCredentials: connectedCredentials,
        id: registrationAccountId,
        metadata: {},
        status: "pending",
      });
      vi.mocked(verifyAwsInvestigationRole).mockResolvedValue(undefined);
      vi.mocked(markIntegrationAccountConnected).mockResolvedValue(true);

      const response = await poll();

      await expect(response.json()).resolves.toEqual({
        awsAccountId,
        roleArn,
        status: "connected",
      });
      expect(verifyAwsInvestigationRole).toHaveBeenCalledWith({
        accountId: awsAccountId,
        externalId,
        roleArn,
      });
      expect(markIntegrationAccountConnected).toHaveBeenCalledWith({
        encryptedCredentials: connectedCredentials,
        integrationAccountId: registrationAccountId,
        organizationId,
        provider: "aws",
      });
      expect(captureAnalyticsEvent).toHaveBeenCalledTimes(1);
      expect(captureAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "integration connected",
          organizationId,
          properties: expect.objectContaining({ provider: "aws" }),
        }),
      );
    });

    it("reports a connected account without verifying again", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
        encryptedCredentials: connectedCredentials,
        id: registrationAccountId,
        metadata: {},
        status: "connected",
      });

      const response = await poll();

      await expect(response.json()).resolves.toEqual({
        awsAccountId,
        roleArn,
        status: "connected",
      });
      expect(verifyAwsInvestigationRole).not.toHaveBeenCalled();
      expect(captureAnalyticsEvent).not.toHaveBeenCalled();
    });

    it("follows a registration merged into an existing row", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue(null as never);
      vi.mocked(getIntegrationAccountMergedFromRegistration).mockResolvedValue({
        encryptedCredentials: connectedCredentials,
        id: existingAccountId,
        metadata: { registrationAccountId },
        status: "connected",
      });

      const response = await poll();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "connected" });
      expect(getIntegrationAccountMergedFromRegistration).toHaveBeenCalledWith({
        organizationId,
        provider: "aws",
        registrationAccountId,
      });
    });

    it("reports a removed setup as missing", async () => {
      vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue(null as never);
      vi.mocked(getIntegrationAccountMergedFromRegistration).mockResolvedValue(null);

      const response = await poll();

      expect(response.status).toBe(404);
    });

    it("requires a session", async () => {
      vi.mocked(getActiveTenant).mockResolvedValue({
        error: "Unauthorized",
        ok: false,
        status: 401,
      });

      const response = await poll();

      expect(response.status).toBe(401);
      expect(getOrganizationIntegrationAccount).not.toHaveBeenCalled();
    });
  });
});
