import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awsRegistrationExternalAccountId,
  awsRegistrationTopicArn,
  clearSnsSigningKeyCache,
  cloudFormationStackAccountId,
  confirmSnsSubscription,
  fetchSnsSigningKey,
  isAcceptedAwsRegistrationTopic,
  isCloudFormationResponseUrl,
  isSnsSigningCertificateUrl,
  sendCloudFormationResponse,
  type SnsMessage,
  snsSigningString,
  verifySnsMessageSignature,
} from "./aws-registration.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certificateUrl =
  "https://sns.eu-west-3.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
const topicArn = "arn:aws:sns:eu-west-3:111122223333:ResponderAwsRegistration";

function signed(
  message: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">,
  version: "1" | "2" = "2",
  key = privateKey,
): SnsMessage {
  const unsigned = {
    ...message,
    Signature: "",
    SignatureVersion: version,
    SigningCertURL: certificateUrl,
  } satisfies SnsMessage;
  const signature = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256")
    .update(snsSigningString(unsigned)!)
    .sign(key, "base64");
  return { ...unsigned, Signature: signature };
}

const notification = {
  Message: '{"RequestType":"Create"}',
  MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
  Timestamp: "2026-11-07T12:00:00.000Z",
  TopicArn: topicArn,
  Type: "Notification" as const,
};

describe("AWS registration topic", () => {
  it("accepts only the configured topic", () => {
    const environment = { AWS_INTEGRATION_REGISTRATION_TOPIC_ARN: topicArn };
    expect(awsRegistrationTopicArn(environment)).toBe(topicArn);
    expect(isAcceptedAwsRegistrationTopic(topicArn, environment)).toBe(true);
    expect(
      isAcceptedAwsRegistrationTopic(
        "arn:aws:sns:eu-west-3:444455556666:ResponderAwsRegistration",
        environment,
      ),
    ).toBe(false);
  });

  it("falls back to the named topic in the broker's account during rollout", () => {
    const environment = {
      AWS_INTEGRATION_PRINCIPAL_ARN:
        "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    };
    expect(awsRegistrationTopicArn(environment)).toBeNull();
    expect(isAcceptedAwsRegistrationTopic(topicArn, environment)).toBe(true);
    expect(
      isAcceptedAwsRegistrationTopic(
        "arn:aws:sns:eu-west-3:444455556666:ResponderAwsRegistration",
        environment,
      ),
    ).toBe(false);
    expect(
      isAcceptedAwsRegistrationTopic(
        "arn:aws:sns:eu-west-3:111122223333:SomethingElse",
        environment,
      ),
    ).toBe(false);
    expect(isAcceptedAwsRegistrationTopic(topicArn, {})).toBe(false);
  });

  it("ignores a malformed configured topic", () => {
    expect(
      awsRegistrationTopicArn({
        AWS_INTEGRATION_REGISTRATION_TOPIC_ARN:
          "arn:aws-cn:sns:cn-north-1:111122223333:ResponderAwsRegistration",
      }),
    ).toBeNull();
  });

  it("keys registrations by a digest, not the external ID", () => {
    const externalAccountId = awsRegistrationExternalAccountId(
      "responder_abcdefghijklmnopqrstuvwxyz1234567890",
    );
    expect(externalAccountId).toMatch(/^registration:[0-9a-f]{64}$/);
    expect(externalAccountId).not.toContain("abcdefghijklmnop");
  });
});

describe("SNS signatures", () => {
  const loadSigningKey = vi.fn(async () => publicKey);

  beforeEach(() => loadSigningKey.mockClear());

  it("verifies SHA256 and SHA1 signatures", async () => {
    await expect(
      verifySnsMessageSignature(signed(notification, "2"), loadSigningKey),
    ).resolves.toBe(true);
    await expect(
      verifySnsMessageSignature(signed(notification, "1"), loadSigningKey),
    ).resolves.toBe(true);
  });

  it("signs a notification's subject only when it has one", async () => {
    const withSubject = signed({ ...notification, Subject: "Registration" });
    expect(snsSigningString(withSubject)).toContain("Subject\nRegistration\n");
    expect(snsSigningString(signed(notification))).not.toContain("Subject");
    await expect(
      verifySnsMessageSignature({ ...withSubject, Subject: "Other" }, loadSigningKey),
    ).resolves.toBe(false);
  });

  it("signs subscription confirmations over their URL and token", async () => {
    const confirmation = signed({
      Message: "You have chosen to subscribe",
      MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
      SubscribeURL:
        "https://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
      Timestamp: "2026-11-07T12:00:00.000Z",
      Token: "abc",
      TopicArn: topicArn,
      Type: "SubscriptionConfirmation",
    });
    expect(snsSigningString(confirmation)).toBe(
      [
        "Message\nYou have chosen to subscribe\n",
        "MessageId\n165545c9-2a5c-472c-8df2-7ff2be2b3b1b\n",
        "SubscribeURL\nhttps://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription&Token=abc\n",
        "Timestamp\n2026-11-07T12:00:00.000Z\n",
        "Token\nabc\n",
        `TopicArn\n${topicArn}\n`,
        "Type\nSubscriptionConfirmation\n",
      ].join(""),
    );
    await expect(verifySnsMessageSignature(confirmation, loadSigningKey)).resolves.toBe(true);
    await expect(
      verifySnsMessageSignature(
        { ...confirmation, SubscribeURL: "https://sns.eu-west-3.amazonaws.com/?Token=evil" },
        loadSigningKey,
      ),
    ).resolves.toBe(false);
  });

  it("rejects a changed message or another key's signature", async () => {
    await expect(
      verifySnsMessageSignature(
        { ...signed(notification), Message: '{"RequestType":"Delete"}' },
        loadSigningKey,
      ),
    ).resolves.toBe(false);
    await expect(
      verifySnsMessageSignature(
        signed(notification, "2", otherKeys.privateKey),
        loadSigningKey,
      ),
    ).resolves.toBe(false);
  });

  it("never loads a certificate from outside SNS", async () => {
    for (const url of [
      "http://sns.eu-west-3.amazonaws.com/cert.pem",
      "https://sns.eu-west-3.amazonaws.com.attacker.example/cert.pem",
      "https://attacker.example/sns.eu-west-3.amazonaws.com/cert.pem",
      "https://sns.eu-west-3.amazonaws.com/cert.txt",
      "https://sns.cn-north-1.amazonaws.com/cert.pem",
      "https://user@sns.eu-west-3.amazonaws.com/cert.pem",
      "https://sns.eu-west-3.amazonaws.com:8443/cert.pem",
    ]) {
      expect(isSnsSigningCertificateUrl(url)).toBe(false);
      await expect(
        verifySnsMessageSignature(
          { ...signed(notification), SigningCertURL: url },
          loadSigningKey,
        ),
      ).resolves.toBe(false);
    }
    expect(loadSigningKey).not.toHaveBeenCalled();
  });
});

describe("SNS signing certificates", () => {
  afterEach(() => clearSnsSigningKeyCache());

  it("caches a certificate by URL", async () => {
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const fetchImpl = vi.fn(async () => new Response(pem));
    const first = await fetchSnsSigningKey(certificateUrl, fetchImpl);
    const second = await fetchSnsSigningKey(certificateUrl, fetchImpl);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      certificateUrl,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("does not cache a failed download", async () => {
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(pem));
    await expect(fetchSnsSigningKey(certificateUrl, fetchImpl)).rejects.toThrow("404");
    await expect(fetchSnsSigningKey(certificateUrl, fetchImpl)).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("CloudFormation custom resource responses", () => {
  const request = {
    LogicalResourceId: "ResponderRegistration",
    RequestId: "f2a3a1c8-1111-4222-8333-444455556666",
    RequestType: "Create" as const,
    ResponseURL:
      "https://cloudformation-custom-resource-response-euwest3.s3.eu-west-3.amazonaws.com/arn%3Aaws?X-Amz-Signature=abc",
    StackId:
      "arn:aws:cloudformation:eu-west-3:123456789012:stack/ResponderInvestigationAccess/0f6c2b70-0000-11ef-0000-0a1b2c3d4e5f",
  };

  it("reads the account from the stack ID", () => {
    expect(cloudFormationStackAccountId(request.StackId)).toBe("123456789012");
    expect(cloudFormationStackAccountId("arn:aws:cloudformation:eu-west-3:1234:stack/x/y"))
      .toBeNull();
    expect(cloudFormationStackAccountId("arn:aws:iam::123456789012:role/x")).toBeNull();
  });

  it("accepts only Amazon S3 response URLs", () => {
    for (const url of [
      "https://s3.amazonaws.com/bucket/key",
      "https://bucket.s3.amazonaws.com/key",
      "https://s3.eu-west-3.amazonaws.com/bucket/key",
      "https://bucket.s3.eu-west-3.amazonaws.com/key",
      "https://bucket.s3-eu-west-1.amazonaws.com/key",
    ]) {
      expect(isCloudFormationResponseUrl(url)).toBe(true);
    }
    for (const url of [
      "http://bucket.s3.amazonaws.com/key",
      "https://s3.amazonaws.com.attacker.example/key",
      "https://attacker.example/s3.amazonaws.com",
      "https://169.254.169.254/latest/meta-data",
      "https://bucket.s3.cn-north-1.amazonaws.com/key",
      "https://bucket.s3-cn-north-1.amazonaws.com/key",
      "https://bucket.s3.amazonaws.com:444/key",
      "not a url",
    ]) {
      expect(isCloudFormationResponseUrl(url)).toBe(false);
    }
  });

  it("uploads the answer CloudFormation expects", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendCloudFormationResponse(
      request,
      {
        Data: { RoleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole" },
        PhysicalResourceId: "responder-registration-123456789012",
        Status: "SUCCESS",
      },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(request.ResponseURL);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "content-type": "" });
    expect(JSON.parse(init.body as string)).toEqual({
      Data: { RoleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole" },
      LogicalResourceId: "ResponderRegistration",
      PhysicalResourceId: "responder-registration-123456789012",
      Reason: "",
      RequestId: request.RequestId,
      StackId: request.StackId,
      Status: "SUCCESS",
    });
  });

  it("does not send an answer outside Amazon S3", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendCloudFormationResponse(
        { ...request, ResponseURL: "https://attacker.example/collect" },
        { PhysicalResourceId: "x", Status: "SUCCESS" },
        fetchImpl,
      ),
    ).rejects.toThrow("not an Amazon S3 URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("confirms subscriptions only on SNS", async () => {
    const fetchImpl = vi.fn(async () => new Response("<ConfirmSubscriptionResponse/>"));
    await confirmSnsSubscription(
      "https://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      confirmSnsSubscription("https://attacker.example/?Action=ConfirmSubscription", fetchImpl),
    ).rejects.toThrow("not an SNS endpoint");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
