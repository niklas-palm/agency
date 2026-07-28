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

## The provider seam

`buildModel(modelKey)` is the only place a model provider is chosen:

- **Anthropic** → `BedrockModel` (Converse API, prompt caching on via `cacheConfig: auto`).
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
