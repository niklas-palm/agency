/**
 * Sample API stack: a REMOVABLE demo downstream API (the pet store in
 * apps/sample-api) to integrate against end-to-end. It is deliberately its own
 * stack, depending on nothing else, so `cdk destroy AgencySampleApi` removes it
 * cleanly without touching the platform.
 *
 * It's the same Hono app the local docker-compose sample-api service runs, on a
 * Lambda behind a public HTTP API. A bearer token (generated in Secrets Manager)
 * gates it - that token is what a user registers as the integration's credential,
 * so the proxy injects it and the agent proves it can call the API without ever
 * seeing the secret. The token is a stack output (fetch it to register the
 * integration); the URL is output too.
 */
import { Stack, type StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export class SampleApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The bearer token the API requires - generated once, held here. This is the
    // credential a user copies into the integration; the proxy injects it downstream.
    const token = new secretsmanager.Secret(this, "SampleApiToken", {
      description: "Bearer token for the Agency sample API (register as the integration credential)",
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    const fn = new NodejsFunction(this, "SampleApiFn", {
      entry: join(REPO_ROOT, "apps/sample-api/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      bundling: { format: "esm" as never, target: "node22" },
      environment: {
        SAMPLE_API_TOKEN: token.secretValue.unsafeUnwrap(), // resolved at deploy into env
      },
    });

    const api = new apigw.HttpApi(this, "SampleApi", {
      apiName: "agency-sample-api",
      defaultIntegration: new HttpLambdaIntegration("SampleApiIntegration", fn),
    });

    new CfnOutput(this, "SampleApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "SampleApiTokenArn", { value: token.secretArn });
  }
}
