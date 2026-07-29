# Models

The set of selectable models is defined once in `packages/shared/src/models.ts` (`MODELS`,
re-exported from the package root)
and resolved to a concrete provider by the runtime's model factory
(`apps/agent-runtime/src/model.ts`). Adding a model is a one-line entry there.

| Key            | Provider | Bedrock model id                              |
|----------------|----------|-----------------------------------------------|
| `sonnet-5`     | bedrock  | `eu.anthropic.claude-sonnet-5`                |
| `opus-4.8`     | bedrock  | `eu.anthropic.claude-opus-4-8`                |
| `haiku-4.5`    | bedrock  | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `gpt-5.6-luna` | openai   | `openai.gpt-5.6-luna`                         |
| `gpt-5.6-terra`| openai   | `openai.gpt-5.6-terra`                        |
| `gpt-5.6-sol`  | openai   | `openai.gpt-5.6-sol`                          |
| `gpt-oss-120b` | openai   | `openai.gpt-oss-120b`                         |

## The OpenAI/Mantle path needs one runtime dependency

`@aws/bedrock-token-generator` is a **direct dependency of `apps/agent-runtime`**, and every
non-Anthropic model depends on it. Getting this wrong is invisible until a real turn runs, so it's
worth knowing why it's there.

Strands' `OpenAIModel` + `bedrockMantleConfig` is keyless in the sense that matters - no OpenAI API
key, AWS credentials only - but it is NOT SigV4-per-request. It builds an async `apiKey` setter
that mints a **bearer token** before each call, and that minting is what needs the package. Strands
declares it an **optional peer dependency** (still true in the latest 1.11.2) and imports it
LAZILY, on first mint, so a missing install throws nothing at boot and fails mid-turn with:

```
Failed to get token from 'apiKey' function: bedrockMantleConfig requires the
'@aws/bedrock-token-generator' package
```

The token is a base64'd SigV4-presigned `bedrock.amazonaws.com/?Action=CallWithBearerToken` URL, so
it comes from the ordinary credential chain - nothing extra to configure, just installed.

**There is no credential-chain-only alternative on Node.** The OpenAI Node SDK does ship a
`BedrockOpenAI` provider, but it refuses to construct without `apiKey` or `bedrockTokenProvider`
("BedrockOpenAI only supports Bedrock bearer token authentication"). The Python SDK's
`openai[bedrock]` extra, which does do SigV4 from the credential chain, has no Node equivalent
today - so the token generator is the mechanism, not a workaround.

**Both Mantle model families are verified working** against the live endpoint through the same
`agent.stream()` path the runtime uses. Their base paths differ and Strands picks between them:
`openai.gpt-5.*` is served from `/openai/v1`, everything else (e.g. `openai.gpt-oss-120b`) from
`/v1`. Nothing in this repo needs to know that - but if a new model 404s while a sibling works,
that split is the first thing to check.

## The provider seam

`buildModel(modelKey)` is the only place a model provider is chosen:

- **Anthropic** → `BedrockModel` (Converse API, prompt caching on via `cacheConfig: auto` -
  a bare `cachePoint`, so writes land in the **5-minute** cache, which is the multiplier
  `MODEL_PRICING` assumes; the 1h TTL would cost 2x and nothing asks for it).
- **OpenAI** → `OpenAIModel` with `bedrockMantleConfig: { region }`. This routes the OpenAI
  client through Bedrock's **OpenAI-compatible "Mantle" endpoint** - **keyless**: the
  bearer token is minted from AWS credentials via `@aws/bedrock-token-generator`. No OpenAI
  API key to store, and OpenAI models obey the same AWS network/billing path as Anthropic.

Both paths use only AWS credentials, so the runtime IAM role's Bedrock grants
(`bedrock:InvokeModel*`/`Converse*` + `bedrock-mantle:CallWithBearerToken`) cover everything.
The Mantle path authorizes against `CallWithBearerToken` (the bearer-token call); the role
also grants `bedrock-mantle:CreateInference` defensively (both are kept - the exact
data-plane action isn't visible in CloudTrail to prune it confidently).

## Notes

- Mantle model ids drop the classic version suffix: `openai.gpt-oss-120b`, **not**
  `openai.gpt-oss-120b-1:0` (the suffix 404s on the Mantle endpoint).
- **Mantle base path is keyed off model family**: `openai.gpt-5.*` models are served from
  `/openai/v1`, all other Mantle models (e.g. `gpt-oss-*`) from `/v1`. This requires
  `@strands-agents/sdk >= 1.10.0` (which resolves the base path from the model id); earlier
  versions keyed it off the API surface and 404'd the gpt-5.6 models.
- The gpt-5.6 models (luna, terra, sol) use the Responses API (Strands' default) - no
  special config beyond `bedrockMantleConfig`.
- **Region.** The platform runs in `eu-north-1`. Anthropic models use the `eu.` cross-region
  inference-profile prefix (a profile prefix must match the calling region). OpenAI/**Mantle is
  us-east-1-only**, so the runtime pins it to `MANTLE_REGION=us-east-1` (agent-runtime) and
  reaches it cross-region - which works in PUBLIC network mode but NOT in ISOLATED mode (no
  cross-region PrivateLink), so **OpenAI models are unavailable to isolated agents** (Anthropic
  works in every mode).
- Adding a model is a one-line entry in the `MODELS` map - the provider seam is identical.
  (Anthropic ids take the `eu.` profile prefix; re-prefix if the platform region changes, or
  use the region-agnostic `global.` profiles.)

## Pricing lives next to the catalog

`MODEL_PRICING` (same file as `MODELS`) turns recorded tokens into the dollar figure on the
Monitor tab. Two things about it are easy to get wrong and worth stating here, next to the
model ids they depend on:

- **Bedrock has two price tiers for the same Anthropic model.** A `global.` inference profile
  is the base rate; a geo-pinned (`eu.`/`us.`) or in-region one is **1.1x** it. Since the ids
  above use `eu.` profiles, the map carries geo-tier rates. Re-prefixing the ids to `global.`
  would make every Anthropic cost figure 10% too high until the map follows.
- **AWS publishes no Mantle rate for the gpt-5.6 family**, so those rows are priced from
  OpenAI's own standard short-context list; only `gpt-oss-*` has a published Bedrock rate
  (identical in eu-north-1 and us-east-1).

How the token counts themselves are normalized - the two providers report prompt-cache hits in
opposite conventions - is in docs/metrics.md.
