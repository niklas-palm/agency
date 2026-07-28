/**
 * Mint a Cognito M2M (client_credentials) access token so scripts and the E2E
 * test can call the control-plane's management endpoints with no interactive
 * login. Reads the M2M client id/secret + token endpoint from env (populated by
 * the CDK Auth stack outputs). Prints the token to stdout.
 *
 *   TOKEN_ENDPOINT=https://<domain>/oauth2/token \
 *   M2M_CLIENT_ID=... M2M_CLIENT_SECRET=... M2M_SCOPE=agency/api \
 *   npx tsx scripts/mint-m2m-token.ts
 */
const endpoint = required("TOKEN_ENDPOINT");
const clientId = required("M2M_CLIENT_ID");
const clientSecret = required("M2M_CLIENT_SECRET");
const scope = process.env.M2M_SCOPE ?? "agency/api";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!res.ok) {
    console.error(`token request failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const json = (await res.json()) as { access_token: string };
  process.stdout.write(json.access_token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
