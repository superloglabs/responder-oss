import { describe, expect, it } from "vitest";
import { awsTelemetryCloudFormationTemplate } from "../telemetry/sources/aws-telemetry.js";
import {
  AWS_INVESTIGATION_ROLE_NAME,
  awsAccountIdSchema,
  awsCloudFormationQuickCreateUrl,
  awsCloudFormationTemplate,
  awsParameterizedCloudFormationTemplate,
  awsIntegrationPrincipalArn,
  awsInvestigationRoleArn,
  isAwsCommercialRegion,
  parseSnsTopicArn,
} from "./aws.js";

const registrationTopicArn =
  "arn:aws:sns:eu-west-3:111122223333:ResponderAwsRegistration";

describe("AWS integration", () => {
  it("builds the fixed customer role ARN", () => {
    expect(awsInvestigationRoleArn("123456789012")).toBe(
      `arn:aws:iam::123456789012:role/${AWS_INVESTIGATION_ROLE_NAME}`,
    );
  });

  it("rejects account IDs with trailing whitespace", () => {
    expect(awsAccountIdSchema.safeParse("123456789012\n").success).toBe(false);
  });

  it("recognizes only regions in the commercial AWS partition", () => {
    expect(isAwsCommercialRegion("eu-west-3")).toBe(true);
    expect(isAwsCommercialRegion("cn-north-1")).toBe(false);
    expect(isAwsCommercialRegion("us-gov-west-1")).toBe(false);
    expect(isAwsCommercialRegion("us-iso-east-1")).toBe(false);
  });

  it("uses the managed AIOps policy and an external-ID trust condition", () => {
    const template = awsCloudFormationTemplate();
    expect(template).toContain("        - arn:aws:iam::aws:policy/AIOpsAssistantPolicy\n");
    expect(template).toContain("sts:ExternalId: !Ref ExternalId");
    expect(template).toContain("AWS: !Ref ResponderPrincipalArn");
    expect(template).toContain("PolicyName: DenySecretValueAccess");
    expect(template).toContain("secretsmanager:GetSecretValue");
    expect(template).toContain("secretsmanager:BatchGetSecretValue");
    expect(template).toContain("ssm:GetParametersByPath");
    expect(template).toContain("kms:Decrypt");
    expect(template).not.toContain("Action: '*'");
  });

  it("pre-fills setup values in the downloadable template", () => {
    const template = awsParameterizedCloudFormationTemplate({
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    });
    expect(template).toContain(
      "Default: 'arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker'",
    );
    expect(template).toContain(
      "Default: 'responder_abcdefghijklmnopqrstuvwxyz1234567890'",
    );
  });

  it("passes setup values to CloudFormation quick create", () => {
    const url = awsCloudFormationQuickCreateUrl({
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
      templateUrl:
        "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml?X-Amz-Signature=test",
    });
    expect(url).toContain("#/stacks/quickcreate?");
    expect(url).toContain("stackName=ResponderInvestigationAccess");
    expect(url).not.toContain("param_IngestKey");
    expect(url).toContain(
      encodeURIComponent(
        "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml?X-Amz-Signature=test",
      ),
    );
    expect(url).toContain("param_ExternalId=responder_");
  });

  it("rejects non-S3 quick-create template URLs", () => {
    expect(() =>
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn:
          "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        templateUrl:
          "https://private-preview.ngrok-free.dev/api/integrations/aws/cloudformation-template",
      }),
    ).toThrow("must use an Amazon S3 URL");
  });

  it("rejects S3 URLs outside the supported commercial AWS partition", () => {
    expect(() =>
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn:
          "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        templateUrl:
          "https://responder-templates.s3.cn-north-1.amazonaws.com.cn/responder-aws-access.yaml",
      }),
    ).toThrow("must use an Amazon S3 URL");
  });

  it("rejects GovCloud S3 quick-create URLs", () => {
    expect(() =>
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn:
          "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        templateUrl:
          "https://responder-templates.s3.us-gov-west-1.amazonaws.com/responder-aws-access.yaml",
      }),
    ).toThrow("must use an Amazon S3 URL");
  });

  it("rejects isolated-partition S3 quick-create URLs", () => {
    expect(() =>
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn:
          "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        templateUrl:
          "https://responder-templates.s3.us-iso-east-1.amazonaws.com/responder-aws-access.yaml",
      }),
    ).toThrow("must use an Amazon S3 URL");
  });

  it("requires a valid broker role ARN", () => {
    expect(() => awsIntegrationPrincipalArn({})).toThrow(
      "AWS account connections are not configured",
    );
    expect(
      awsIntegrationPrincipalArn({
        AWS_INTEGRATION_PRINCIPAL_ARN:
          "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
      }),
    ).toBe("arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker");
  });
  it("reports the account only when a registration topic is set", () => {
    const template = awsCloudFormationTemplate();
    expect(template).toMatch(
      / {2}RegistrationTopicArn:\n {4}Type: String\n {4}Default: ""\n/,
    );
    expect(template).toContain(
      'RegisterWithResponder: !Not [!Equals [!Ref RegistrationTopicArn, ""]]',
    );
    const resource = resourceBlock(template, "ResponderAccountRegistration");
    expect(resource).toContain("Type: Custom::ResponderRegistration");
    expect(resource).toContain("Condition: RegisterWithResponder");
    expect(resource).toContain("ServiceToken: !GetAtt RegistrationForwarder.Arn");
    expect(resource).toContain("ExternalId: !Ref ExternalId");
    expect(resource).toContain("RoleArn: !GetAtt InvestigationRole.Arn");
    // CloudFormation cannot move a custom resource to another ServiceToken,
    // so the forwarded registration has a new logical ID.
    expect(template).not.toMatch(/^ {2}ResponderRegistration:/m);
    for (const id of ["RegistrationForwarder", "RegistrationForwarderRole"]) {
      expect(resourceBlock(template, id)).toContain("Condition: RegisterWithResponder");
    }
    expect(resourceBlock(template, "RegistrationForwarderRole")).toContain(
      "Action: sns:Publish\n                Resource: !Ref RegistrationTopicArn",
    );
    // The role exists without a topic or an ingest key.
    expect(resourceBlock(template, "InvestigationRole")).not.toContain("Condition: ");
  });

  it("forwards registration to the topic's region and answers Delete itself", () => {
    const code = resourceBlock(awsCloudFormationTemplate(), "RegistrationForwarder");
    expect(code).toContain('boto3.client("sns", region_name=topic.split(":")[3])');
    expect(code).toContain('if event["RequestType"] == "Delete":');
    expect(code).toContain('respond(event, "FAILED"');
  });

  it("streams logs only with an ingest key", () => {
    const template = awsCloudFormationTemplate();
    expect(template).toMatch(/ {2}IngestKey:\n {4}Type: String\n {4}Default: ""\n {4}NoEcho: true\n/);
    expect(template).toMatch(/ {2}EnableMetrics:\n(?: {4}.*\n)*? {4}Default: "false"\n/);
    expect(template).toMatch(/ {2}EnableLogs:\n(?: {4}.*\n)*? {4}Default: "true"\n/);
    for (const id of streamResourceIds) {
      expect(resourceBlock(template, id)).toMatch(/\n {4}Condition: (?:StreamTelemetry|CreateLogs|CreateMetrics)\n/);
    }
    expect(template).toContain("  CreateLogs: !And\n    - !Condition StreamTelemetry\n");
    expect(template).toContain("  CreateMetrics: !And\n    - !Condition StreamTelemetry\n");
  });

  it("streams with the same resources as the telemetry stack", () => {
    const combined = awsCloudFormationTemplate();
    const telemetry = awsTelemetryCloudFormationTemplate();
    const withoutConditions = (block: string) => block.replace(/^ {4}Condition: .*\n/gm, "");
    expect(streamResourceIds.length).toBeGreaterThan(0);
    for (const id of streamResourceIds) {
      expect(withoutConditions(resourceBlock(combined, id)), id).toBe(
        withoutConditions(resourceBlock(telemetry, id)),
      );
    }
  });

  it("leaves the registration topic empty unless one is given", () => {
    const input = {
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    };
    const topicDefault = '    Default: ""\n    Description: SNS topic';
    expect(awsParameterizedCloudFormationTemplate(input)).toContain(topicDefault);
    const template = awsParameterizedCloudFormationTemplate({
      ...input,
      registrationTopicArn,
    });
    expect(template).toContain(`Default: '${registrationTopicArn}'`);
    expect(template).not.toContain(topicDefault);
    expect(() =>
      awsParameterizedCloudFormationTemplate({
        ...input,
        registrationTopicArn: "arn:aws:sns:eu-west-3:111122223333:bad'topic",
      }),
    ).toThrow("SNS topic ARN");
  });

  it("opens one-click quick create in the registration topic's region by default", () => {
    const url = new URL(
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        registrationTopicArn,
        templateUrl:
          "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml",
      }),
    );
    expect(url.hostname).toBe("eu-west-3.console.aws.amazon.com");
    expect(url.searchParams.get("region")).toBe("eu-west-3");
    const parameters = new URLSearchParams(url.hash.split("?")[1]);
    expect(url.hash.startsWith("#/stacks/quickcreate?")).toBe(true);
    expect(parameters.get("param_RegistrationTopicArn")).toBe(registrationTopicArn);
    expect(parameters.get("param_ExternalId")).toBe(
      "responder_abcdefghijklmnopqrstuvwxyz1234567890",
    );
  });

  it("opens the stack in the chosen region with the log stream filled in", () => {
    const url = new URL(
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        region: "eu-west-1",
        registrationTopicArn,
        stream: {
          ingestKey: "sl_ingest_test",
          ingestUrl: "https://superlog.sh/",
          resourcePrefix: "superlog-0a1b2c3d",
        },
        templateUrl:
          "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml",
      }),
    );
    expect(url.hostname).toBe("eu-west-1.console.aws.amazon.com");
    expect(url.searchParams.get("region")).toBe("eu-west-1");
    const parameters = new URLSearchParams(url.hash.split("?")[1]);
    expect(parameters.get("param_RegistrationTopicArn")).toBe(registrationTopicArn);
    expect(parameters.get("param_IngestKey")).toBe("sl_ingest_test");
    expect(parameters.get("param_IngestUrl")).toBe("https://superlog.sh");
    expect(parameters.get("param_ResourcePrefix")).toBe("superlog-0a1b2c3d");
    expect(() =>
      awsCloudFormationQuickCreateUrl({
        externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
        principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
        region: "us-gov-west-1",
        templateUrl:
          "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml",
      }),
    ).toThrow("commercial AWS region");
  });

  it("parses only commercial SNS topic ARNs", () => {
    expect(parseSnsTopicArn(registrationTopicArn)).toEqual({
      accountId: "111122223333",
      name: "ResponderAwsRegistration",
      region: "eu-west-3",
    });
    expect(parseSnsTopicArn("arn:aws:sns:us-gov-west-1:111122223333:x")).toBeNull();
    expect(parseSnsTopicArn("arn:aws:sqs:eu-west-3:111122223333:x")).toBeNull();
  });
});

const streamResourceIds = [
  "BackupBucket",
  "DeliveryLogGroup",
  "MetricsDeliveryLogStream",
  "LogsDeliveryLogStream",
  "FirehoseRole",
  "MetricsDeliveryStream",
  "MetricStreamRole",
  "MetricStream",
  "LogsDeliveryStream",
  "LogsToFirehoseRole",
  "LogsSubscription",
];

// A top-level resource, from its logical ID to the next resource or section.
function resourceBlock(template: string, logicalId: string): string {
  const resources = template.slice(template.indexOf("\nResources:\n"));
  const start = resources.indexOf(`\n  ${logicalId}:\n`);
  if (start < 0) throw new Error(`${logicalId} is missing`);
  const rest = resources.slice(start + 1);
  const end = rest.slice(1).search(/\n(?: {2}[A-Za-z]|\S)/);
  return end < 0 ? rest : rest.slice(0, end + 2);
}
