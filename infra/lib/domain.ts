/**
 * The optional custom domain, resolved once from CDK context.
 *
 * Two keys, set together or not at all:
 *   `domainName`   - the apex this deployment serves the SPA on (e.g. agency.example.com)
 *   `hostedZoneId` - its PUBLIC Route53 hosted zone, which must already exist AND be
 *                    delegated (the parent zone's NS records point at it). Certificates
 *                    are DNS-validated in that zone, so an undelegated zone doesn't fail
 *                    fast - it leaves CloudFormation waiting on validation for hours.
 *
 * The API host is always `api.<domainName>`: one decision for the deployer instead of
 * two, and one certificate per front door (CloudFront's must be in us-east-1, API
 * Gateway's must be regional - see AgencyWebCert / AgencyControlPlane).
 *
 * Context rather than tracked config, like `webCallbackUrl`: a domain and a zone id are
 * live deployment identifiers and this repository is public (CONTRIBUTING.md). Unset =
 * no custom domain, i.e. the CloudFront + execute-api hostnames, which is what a fork or
 * a throwaway stack gets. CI passes both from repo variables (see
 * .github/workflows/deploy.yml) - without that, a deploy from CI would REMOVE the
 * domain a local deploy had configured.
 */
import type { Construct } from "constructs";

export interface DomainConfig {
  /** Apex the SPA is served on, e.g. `agency.example.com`. */
  readonly siteDomain: string;
  /** The API host - always `api.<siteDomain>`. */
  readonly apiDomain: string;
  /** The existing public hosted zone for `siteDomain`. */
  readonly hostedZoneId: string;
}

/** Reads the two context keys; `undefined` means "no custom domain". */
export function resolveDomain(scope: Construct): DomainConfig | undefined {
  const siteDomain = contextString(scope, "domainName");
  const hostedZoneId = contextString(scope, "hostedZoneId");
  if (!siteDomain && !hostedZoneId) return undefined;
  // Half-configured is always a mistake, and both halves fail in slow, confusing ways
  // (a domain with no zone can't be DNS-validated; a zone with no domain names nothing),
  // so refuse at synth instead.
  if (!siteDomain || !hostedZoneId) {
    throw new Error(
      "domainName and hostedZoneId must be set together (got " +
        `domainName=${siteDomain ?? "<unset>"}, hostedZoneId=${hostedZoneId ?? "<unset>"}). ` +
        "Set both in infra/cdk.context.json or pass -c domainName=… -c hostedZoneId=…, " +
        "or neither to serve on the CloudFront + execute-api hostnames.",
    );
  }
  return { siteDomain, apiDomain: `api.${siteDomain}`, hostedZoneId };
}

/** A non-empty trimmed context string, or undefined. Guards `-c key=` and non-strings. */
function contextString(scope: Construct, key: string): string | undefined {
  const raw = scope.node.tryGetContext(key);
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}
