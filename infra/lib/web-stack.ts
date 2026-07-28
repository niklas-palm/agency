/**
 * Web stack: the SPA on S3 + CloudFront. The bucket is private; only
 * CloudFront (via Origin Access Identity) can read it. SPA routing (404/403 →
 * index.html) lets the hash router and OAuth callback path work on refresh.
 *
 * The SPA build is a plain asset deploy; the build itself (with VITE_API_URL /
 * Cognito config) is produced by the deploy pipeline before `cdk deploy` - see
 * docs/deployment.md. This stack only hosts and serves it.
 *
 * With a custom domain configured (infra/lib/domain.ts) the distribution also answers
 * on the site domain, using the us-east-1 certificate from AgencyWebCert, and this
 * stack owns the apex alias records that point there.
 */
import { Stack, type StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { Annotations } from "aws-cdk-lib";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DomainConfig } from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, "..", "..", "apps", "web", "dist");

interface WebStackProps extends StackProps {
  /**
   * The custom domain and the us-east-1 certificate for it - one prop, because
   * CloudFront needs both or neither (a `domainNames` without a matching certificate
   * is rejected).
   */
  site?: { domain: DomainConfig; certificateArn: string };
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props?: WebStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    bucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      // The alternate domain name + its certificate (us-east-1 only - AgencyWebCert).
      domainNames: props?.site ? [props.site.domain.siteDomain] : undefined,
      certificate: props?.site
        ? acm.Certificate.fromCertificateArn(this, "SiteCertificate", props.site.certificateArn)
        : undefined,
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      // SPA: serve index.html for client-routed paths so refresh / the OAuth
      // callback path don't 404.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // Deploy the built SPA - but only if it's been built. `Source.asset` throws at
    // CONSTRUCT time on a missing directory, which on a fresh clone breaks the whole
    // CDK app: not just this stack, but `cdk list`/`synth`/`deploy AgencyAuth` too.
    // That's a chicken-and-egg trap, because the SPA build needs the API + Cognito
    // ids that only exist AFTER the first deploy (see docs/deployment.md). So an
    // unbuilt SPA synthesizes to an empty site with a loud warning instead: deploy
    // the backend, build with its outputs, then deploy again to publish the bundle.
    if (existsSync(WEB_DIST)) {
      new s3deploy.BucketDeployment(this, "DeploySite", {
        sources: [s3deploy.Source.asset(WEB_DIST)],
        destinationBucket: bucket,
        distribution,
        distributionPaths: ["/*"],
      });
    } else {
      Annotations.of(this).addWarning(
        `apps/web/dist not found - deploying an EMPTY site. Build the SPA (see docs/deployment.md: it needs VITE_API_URL + the Cognito ids from AgencyAuth/AgencyControlPlane) and deploy ${id} again.`,
      );
    }

    // Apex alias records: the hosted zone IS the site domain, so no recordName. Both
    // families, because CloudFront serves IPv6 as well as IPv4.
    if (props?.site) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.site.domain.hostedZoneId,
        zoneName: props.site.domain.siteDomain,
      });
      const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, "SiteAliasA", { zone, target });
      new route53.AaaaRecord(this, "SiteAliasAaaa", { zone, target });
    }

    // The origin the deployment is REACHED on: the custom domain when there is one.
    // CI's smoke test hits this output. The `*.cloudfront.net` hostname keeps serving the
    // SPA regardless - an alternate domain name adds a name, it doesn't remove one.
    const siteUrl = props?.site
      ? `https://${props.site.domain.siteDomain}`
      : `https://${distribution.distributionDomainName}`;
    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    // Named outputs so CI can do a UI-only deploy without a CloudFormation run: sync the
    // new bundle to the bucket and invalidate the distribution directly. See
    // .github/workflows/deploy.yml.
    new CfnOutput(this, "SiteBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
  }
}
