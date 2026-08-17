import { describe, expect, it } from "vitest";
import {
  AWS_INVESTIGATION_ROLE_NAME,
  awsCloudFormationQuickCreateUrl,
  awsCloudFormationTemplate,
  awsIntegrationPrincipalArn,
  awsInvestigationRoleArn,
} from "./aws.js";

describe("AWS integration", () => {
  it("builds the fixed customer role ARN", () => {
    expect(awsInvestigationRoleArn("123456789012")).toBe(
      `arn:aws:iam::123456789012:role/${AWS_INVESTIGATION_ROLE_NAME}`,
    );
  });

  it("uses the managed AIOps policy and an external-ID trust condition", () => {
    const template = awsCloudFormationTemplate();
    expect(template).toContain("aws:policy/AIOpsAssistantPolicy");
    expect(template).toContain("sts:ExternalId: !Ref ExternalId");
    expect(template).toContain("AWS: !Ref ResponderPrincipalArn");
    expect(template).not.toContain("Action: '*'");
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
});
