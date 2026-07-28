/**
 * Web-search stack — pinned to us-east-1, the ONLY region that offers AWS's
 * managed AgentCore `web-search` connector (its `tool/web-search.v1` ARN exists
 * only there). It provisions one shared MCP Gateway fronting that connector; the
 * eu-north-1 control-plane wires the PUBLIC runtime to call it CROSS-REGION
 * (SigV4 to us-east-1, over the runtime's public egress), the same way the
 * OpenAI/Mantle models are reached cross-region.
 *
 * This is intentionally its own stack (not part of AgencyControlPlane) because
 * CloudFormation stacks are single-region: the gateway must live in us-east-1
 * while everything else lives in eu-north-1. The control-plane consumes the
 * gateway URL + ARN via CDK cross-region references. The gateway is a managed
 * MCP endpoint with NO VPC/ENIs, so this us-east-1 footprint tears down cleanly
 * (unlike the runtime microVMs) — `cdk destroy AgencyWebSearch` and it's gone.
 */
import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";

export class WebSearchStack extends Stack {
  /** The MCP gateway URL the runtime connects to (SigV4-signed). */
  readonly gatewayUrl: string;
  /** The gateway ARN, so the runtime role (in the other region) can be granted InvokeGateway on it. */
  readonly gatewayArn: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The managed connector tool this gateway fronts (us-east-1 only).
    const webSearchToolArn = `arn:aws:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`;
    // The assumedBy SourceArn must be a pattern (pinning it to the gateway's own
    // ARN would create a role↔gateway circular dependency); the invoke grant
    // below is pinned to the concrete gateway ARN once it exists.
    const gatewayArnPattern = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`;

    const gatewayRole = new iam.Role(this, "WebSearchGatewayRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": gatewayArnPattern },
        },
      }),
      description: "Assumed by the Agency web-search gateway to call the managed connector",
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeWebSearch"], resources: [webSearchToolArn] }),
    );

    const gateway = new agentcore.CfnGateway(this, "WebSearchGateway", {
      name: "agency-web-search",
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
      protocolConfiguration: { mcp: { supportedVersions: ["2025-03-26"] } },
      roleArn: gatewayRole.roleArn,
    });
    new agentcore.CfnGatewayTarget(this, "WebSearchTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "web-search",
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            configurations: [{ name: "WebSearch", parameterValues: {} }],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    });

    // The gateway role invokes its own target; the runtime role (granted in the
    // control-plane stack, cross-region) also needs InvokeGateway on this ARN.
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [gateway.attrGatewayArn],
      }),
    );

    this.gatewayUrl = gateway.attrGatewayUrl;
    this.gatewayArn = gateway.attrGatewayArn;
    new CfnOutput(this, "GatewayUrl", { value: this.gatewayUrl });
    new CfnOutput(this, "GatewayArn", { value: this.gatewayArn });
  }
}
