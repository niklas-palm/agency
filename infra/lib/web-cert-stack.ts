/**
 * Web-certificate stack - pinned to us-east-1 because CloudFront accepts an ACM
 * certificate ONLY from us-east-1, whatever region the distribution's other resources
 * live in. That is the same single-region constraint that gives AgencyWebSearch its own
 * stack: a CloudFormation stack is single-region, so a us-east-1 resource needed by the
 * eu-north-1 deployment has to live in one of its own.
 *
 * It holds nothing but the DNS-validated certificate for the site domain; `AgencyWeb`
 * consumes the ARN via CDK cross-region references. Only synthesized when a custom
 * domain is configured (see infra/lib/domain.ts).
 *
 * The API's certificate is NOT here: an API Gateway regional custom domain requires a
 * certificate from its OWN region, so it's created in AgencyControlPlane (eu-north-1).
 */
import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { DomainConfig } from "./domain.js";

interface WebCertStackProps extends StackProps {
  domain: DomainConfig;
}

export class WebCertStack extends Stack {
  /** ARN of the us-east-1 certificate for the site domain (consumed by AgencyWeb). */
  readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: WebCertStackProps) {
    super(scope, id, props);

    // Route53 is global, so a zone imported here validates records fine from us-east-1.
    // Imported by id+name rather than `fromLookup`: the stacks are account-agnostic
    // (bin/agency.ts sets only a region), and a lookup needs a concrete account.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.domain.hostedZoneId,
      zoneName: props.domain.siteDomain,
    });

    const certificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: props.domain.siteDomain,
      // CloudFormation writes the validation CNAME into the zone itself and waits for
      // ACM to issue - so the zone must already be delegated (see domain.ts).
      validation: acm.CertificateValidation.fromDns(zone),
    });

    this.certificateArn = certificate.certificateArn;
    new CfnOutput(this, "CertificateArn", { value: certificate.certificateArn });
  }
}
