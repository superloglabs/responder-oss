import { describe, expect, it } from "vitest";
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
    expect(template).toContain("aws:policy/AIOpsAssistantPolicy");
    expect(template).not.toContain("AWS::Partition");
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
    expect(url).toContain("#/stacks/create/review?");
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
    const resource = template.slice(
      template.indexOf("  ResponderRegistration:"),
      template.indexOf("Outputs:"),
    );
    expect(resource).toContain("Type: Custom::ResponderRegistration");
    expect(resource).toContain("Condition: RegisterWithResponder");
    expect(resource).toContain("DependsOn: InvestigationRole");
    expect(resource).toContain("ServiceToken: !Ref RegistrationTopicArn");
    expect(resource).toContain("ExternalId: !Ref ExternalId");
    expect(resource).toContain("RoleArn: !GetAtt InvestigationRole.Arn");
    // Only registration and the log subscription role (with its output)
    // are conditional, so empty parameters leave the stack as it was before
    // either existed.
    expect(template.match(/^ {4}Condition: \S+/gm)).toEqual([
      "    Condition: ManageLogSubscriptions",
      "    Condition: RegisterWithResponder",
      "    Condition: ManageLogSubscriptions",
    ]);
  });

  it("leaves the registration topic empty unless one is given", () => {
    const input = {
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    };
    expect(awsParameterizedCloudFormationTemplate(input)).toContain('    Default: ""\n');
    const template = awsParameterizedCloudFormationTemplate({
      ...input,
      registrationTopicArn,
    });
    expect(template).toContain(`Default: '${registrationTopicArn}'`);
    expect(template).not.toContain('    Default: ""\n    Description: SNS topic');
    expect(() =>
      awsParameterizedCloudFormationTemplate({
        ...input,
        registrationTopicArn: "arn:aws:sns:eu-west-3:111122223333:bad'topic",
      }),
    ).toThrow("SNS topic ARN");
  });

  it("opens one-click quick create in the registration topic's region", () => {
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
    expect(url.hash.startsWith("#/stacks/create/review?")).toBe(true);
    expect(parameters.get("param_RegistrationTopicArn")).toBe(registrationTopicArn);
    expect(parameters.get("param_ExternalId")).toBe(
      "responder_abcdefghijklmnopqrstuvwxyz1234567890",
    );
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

  it("adds a log subscription role that can only manage subscription policies", () => {
    const template = awsCloudFormationTemplate();
    const block = template.slice(template.indexOf("  LogSubscriptionRole:"), template.indexOf("  ResponderRegistration:"));
    expect(block).toContain("Condition: ManageLogSubscriptions");
    expect(block).toContain("RoleName: ResponderLogSubscriptionRole");
    expect(block).toContain("AWS: !Ref LogSubscriptionPrincipalArn");
    expect(block).toContain("sts:ExternalId: !Ref ExternalId");
    const actions = [...block.matchAll(/^ {18}- (\S+)$/gmu)].map((match) => match[1]);
    expect(actions).toEqual([
      "logs:PutAccountPolicy",
      "logs:PutSubscriptionFilter",
      "logs:DeleteAccountPolicy",
      "logs:DeleteSubscriptionFilter",
      "logs:DescribeAccountPolicies",
    ]);
    expect(block).not.toContain("ManagedPolicyArns");
    expect(template).toContain('ManageLogSubscriptions: !Not [!Equals [!Ref LogSubscriptionPrincipalArn, ""]]');
  });

  it("leaves the log subscription role out unless a broker is given", () => {
    const withoutBroker = awsParameterizedCloudFormationTemplate({
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    });
    expect(withoutBroker).toContain("    Default: \"\"\n    Description: Superlog's log subscription broker role ARN");
    const withBroker = awsParameterizedCloudFormationTemplate({
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      logSubscriptionPrincipalArn: "arn:aws:iam::111122223333:role/ResponderLogSubscriptionBroker",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    });
    expect(withBroker).toContain("    Default: 'arn:aws:iam::111122223333:role/ResponderLogSubscriptionBroker'\n    Description: Superlog's log subscription broker role ARN");
    expect(() => awsParameterizedCloudFormationTemplate({
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      logSubscriptionPrincipalArn: "not-an-arn",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    })).toThrow();
  });

  it("passes the log subscription broker to quick create when there is one", () => {
    const base = {
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      principalArn: "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
      registrationTopicArn,
      templateUrl: "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml",
    };
    const parameters = (url: string) => new URLSearchParams(new URL(url).hash.split("?")[1]);
    expect(parameters(awsCloudFormationQuickCreateUrl(base)).has("param_LogSubscriptionPrincipalArn")).toBe(false);
    expect(parameters(awsCloudFormationQuickCreateUrl({
      ...base,
      logSubscriptionPrincipalArn: "arn:aws:iam::111122223333:role/ResponderLogSubscriptionBroker",
    })).get("param_LogSubscriptionPrincipalArn")).toBe("arn:aws:iam::111122223333:role/ResponderLogSubscriptionBroker");
  });
});
