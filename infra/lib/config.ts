/**
 * Structural configuration (region, naming). Pinned here rather than in env so
 * infra is reproducible.
 *
 * Region is eu-north-1: AgentCore + Bedrock (Anthropic) are available there. The
 * OpenAI-via-Bedrock-Mantle endpoint is us-east-1-only, so the runtime reaches it
 * cross-region (see agent-runtime `MANTLE_REGION`) - fine in public network mode;
 * OpenAI models are unavailable in ISOLATED mode here (no cross-region PrivateLink),
 * while Anthropic works in every mode.
 */
export const REGION = "eu-north-1";

/**
 * The region that offers AWS's managed AgentCore `web-search` connector - only
 * us-east-1 today. The web-search gateway is provisioned there (AgencyWebSearch)
 * and the eu-north-1 runtime calls it cross-region (SigV4 to this region), the
 * same cross-region pattern as the OpenAI/Mantle models. Pinned separately from
 * REGION so it can widen if the connector expands to more regions.
 */
export const WEB_SEARCH_REGION = "us-east-1";


// Note: table names are NOT pinned here - CDK derives unique physical names (see
// data-stack.ts) and passes them to consumers via env, so a rename never forces a
// table replacement.

/**
 * Cognito domain prefix for the hosted OAuth token endpoint (M2M).
 *
 * GLOBALLY unique per region, so two deployments in one region collide and the second
 * auth stack fails. Override with `-c cognitoDomainPrefix=…` (or in cdk.context.json);
 * `cognitoDomainPrefix` in auth-stack.ts resolves it. This is only the default.
 */
export const COGNITO_DOMAIN_PREFIX = "agency-auth";

/** OAuth scope M2M clients request. */
export const M2M_SCOPE = "api";
export const RESOURCE_SERVER_ID = "agency";
