/**
 * PR-preview hosting: one bucket + one CloudFront distribution that serve EVERY open
 * preview, at `<pr-number>.<domainName>`.
 *
 * The shape is chosen so that publishing a preview needs no CloudFormation at all - CI
 * does `s3 sync` into a `<pr>/` prefix and one invalidation, which is why a preview lands
 * in about a minute (see .github/workflows/preview.yml). A distribution per PR would mean
 * a stack, a certificate and a DNS record per PR, minutes of wait, and a quota to run out
 * of; a per-PR *prefix* behind a wildcard alias costs one function.
 *
 * A CloudFront viewer-request function maps the host's first label to that prefix
 * (`123.example.com/assets/x` → `s3://…/123/assets/x`) and appends `index.html` for a
 * directory request, so the SPA's absolute asset paths work unchanged - no per-preview
 * Vite `base`. The label must be all digits: a preview is a PR number, and anything else
 * gets a 404 straight from the edge rather than an S3 AccessDenied page.
 *
 * Why a separate origin (a subdomain) and NOT a path on the production distribution: the
 * SPA keeps its tokens in localStorage, which is per-origin. Serving unreviewed PR code
 * from the production origin would give it read access to a signed-in user's real access
 * token. A sibling host shares nothing (and the console sets no cookies, so there is
 * nothing to scope to the parent domain either).
 *
 * OPT-IN, and only with a custom domain: `-c previews=true` plus `domainName` +
 * `hostedZoneId`. A wildcard DNS record and a second distribution are not something a
 * fork or a trial deployment should get by surprise.
 */
import { Stack, type StackProps, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DomainConfig } from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WebPreviewStackProps extends StackProps {
  domain: DomainConfig;
  /** ARN of the us-east-1 `*.<siteDomain>` certificate (AgencyWebCert). */
  certificateArn: string;
  /** Days after which an abandoned preview's objects expire (belt to CI's teardown). */
  expireAfterDays?: number;
}

export class WebPreviewStack extends Stack {
  constructor(scope: Construct, id: string, props: WebPreviewStackProps) {
    super(scope, id, props);

    const expireAfterDays = props.expireAfterDays ?? 30;

    // Previews are disposable, so the bucket is too: CI deletes a PR's prefix when the
    // PR closes, and the lifecycle rule catches whatever CI missed (a cancelled teardown,
    // a PR closed while the workflow was disabled). Without it an abandoned prefix lives
    // forever, which is exactly how a preview bucket turns into a mystery bill.
    const bucket = new s3.Bucket(this, "PreviewBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: "expire-stale-previews", expiration: Duration.days(expireAfterDays) }],
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    bucket.grantRead(oai);

    // Host → key prefix. The rule itself lives in preview-router.js (and is tested there):
    // it is what keeps one PR's preview from serving another's bundle.
    const router = new cloudfront.Function(this, "PreviewRouter", {
      comment: "Route <pr>.<domain> to the s3 key prefix <pr>/",
      code: cloudfront.FunctionCode.fromFile({ filePath: join(__dirname, "preview-router.js") }),
    });

    // A preview must never be indexed: it is a real, signed-in console pointed at the
    // production API, on a guessable hostname.
    const headers = new cloudfront.ResponseHeadersPolicy(this, "PreviewHeaders", {
      customHeadersBehavior: {
        customHeaders: [
          { header: "X-Robots-Tag", value: "noindex, nofollow", override: true },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, "PreviewDistribution", {
      // No defaultRootObject: the function resolves `/` to `<pr>/index.html` itself, so
      // the prefix is applied in exactly one place.
      domainNames: [`*.${props.domain.siteDomain}`],
      certificate: acm.Certificate.fromCertificateArn(this, "PreviewCertificate", props.certificateArn),
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        functionAssociations: [
          { function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // Previews are looked at by a handful of reviewers, so pay for the cheapest
      // edge footprint rather than the global one.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // `*.<domain>` - one record for every preview there will ever be. An explicit record
    // always wins over a wildcard, so the apex (AgencyWeb) and `api.` (AgencyControlPlane)
    // are unaffected; any OTHER subdomain now resolves here and gets the function's 404.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.domain.hostedZoneId,
      zoneName: props.domain.siteDomain,
    });
    const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "PreviewAliasA", { zone, target, recordName: `*.${props.domain.siteDomain}` });
    new route53.AaaaRecord(this, "PreviewAliasAaaa", { zone, target, recordName: `*.${props.domain.siteDomain}` });

    // What CI needs to publish a preview: where to sync, what to invalidate, and the
    // hostname to comment on the PR. Read from the stack, so no workflow file has to
    // carry this deployment's domain (CONTRIBUTING.md: nothing live in a tracked file).
    new CfnOutput(this, "PreviewBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "PreviewDistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "PreviewHostSuffix", { value: props.domain.siteDomain });
  }
}
