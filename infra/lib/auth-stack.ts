/**
 * Auth stack: Cognito user pool for interactive users plus an M2M
 * (client-credentials) app client so scripts and the E2E test can obtain access
 * tokens with no interactive login. A resource server defines the `api` scope
 * the M2M client requests; a hosted domain provides the /oauth2/token endpoint.
 */
import { Stack, type StackProps, CfnOutput, RemovalPolicy, Duration, Annotations } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COGNITO_DOMAIN_PREFIX, M2M_SCOPE, RESOURCE_SERVER_ID, REGION } from "./config.js";
import type { DomainConfig } from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

interface AuthStackProps extends StackProps {
  /** The custom domain, when configured - it is the app origin the invite email links to. */
  domain?: DomainConfig;
}

export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly m2mClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: AuthStackProps) {
    super(scope, id, props);

    // The web app origin (CloudFront). Its only use now is the invite email's
    // sign-in link (appUrl, below). (It's no longer an
    // OAuth callback - the web client sets disableOAuth, so no callback is
    // registered.) Falls back to the local dev origin when unset. The name is
    // historical; it's really just the app origin.
    // REQUIRED for anything but a throwaway stack. It's the sign-in link in the invite
    // email, so a wrong value mails your users at someone else's app - which is why the
    // repo ships no default. With a custom domain configured the SPA's origin IS that
    // link, so it's derived from `domainName` and needs no second setting; otherwise set
    // it in infra/cdk.context.json or with `-c webCallbackUrl=…`. Falling
    // back to localhost is only sane for local dev, so say so loudly rather than
    // shipping broken invite emails.
    // Globally unique per region, so a second deployment in the same region needs its
    // own. Defaults to ours; override with `-c cognitoDomainPrefix=…`.
    const domainPrefix =
      (this.node.tryGetContext("cognitoDomainPrefix") as string | undefined) ?? COGNITO_DOMAIN_PREFIX;

    const webCallbackUrl = this.node.tryGetContext("webCallbackUrl") as string | undefined;
    const siteUrl = props?.domain ? `https://${props.domain.siteDomain}/` : undefined;
    const appUrl = webCallbackUrl ?? siteUrl ?? "http://localhost:5173/";
    if (!webCallbackUrl && !siteUrl) {
      Annotations.of(this).addWarning(
        "neither webCallbackUrl nor domainName is set - invite emails will link to " +
          "http://localhost:5173/. Set one in infra/cdk.context.json or pass " +
          "-c webCallbackUrl=https://your-app/",
      );
    }

    this.userPool = new cognito.UserPool(this, "UserPool", {
      // No explicit userPoolName - CDK infers it; the pool is referenced by id.
      // Admin-only: no public sign-up. This sets Cognito's
      // AdminCreateUserConfig.AllowAdminCreateUserOnly = true, so users can only
      // be created by an admin (console / AdminCreateUser API), never self-service.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // Cognito must send the temp-password invite AND verify emails from a real
      // address; the default COGNITO account is fine for this admin-only console.
      autoVerify: { email: true },
      // Changing `email` requires re-verifying it, and the OLD address stays active
      // until then. The email claim is an authority input - it decides which pending
      // invite a caller may accept - so a user who could freely self-assign an address
      // could claim an invite addressed to someone else. `keepOriginal` is what makes
      // the un-verified new value non-authoritative rather than merely un-flagged.
      keepOriginal: { email: true },
      // Forgot-password recovers via email only. Cognito's default lists
      // verified_phone_number first, but we collect no phone - that would make
      // password reset dead-end. EMAIL_ONLY makes the reset code go to email.
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // The admin-create-user invite email. Cognito substitutes {username} (the
      // email) and {####} (the temporary password). We add where to sign in and
      // that the first sign-in forces a new password - the raw default says
      // neither, so an invitee gets a bare code with no destination.
      userInvitation: {
        emailSubject: "Your Agency sign-in details",
        emailBody: [
          `<p>You've been given access to <b>Agency</b> - the platform for building and running agents.</p>`,
          `<p>Sign in here: <a href="${appUrl}">${appUrl}</a></p>`,
          // {username} + {####} are Cognito's own placeholders (the email + the
          // temporary password), substituted server-side - not JS interpolation.
          `<p>Username: <b>{username}</b><br/>Temporary password: <b>{####}</b></p>`,
          `<p>You'll be asked to choose a new password on your first sign-in.</p>`,
        ].join(""),
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Pre-token-generation trigger (V2): copy the user's `email` attribute into
    // the ACCESS token. The SPA authenticates the API with the access token, which
    // by default carries no `email` - but the org model matches invites by verified
    // email (GET /invites, accept/decline) and names the personal org from it.
    // V2_0 is required to customize the access token (V1_0 only reaches the ID
    // token); it's an Essentials-plan feature. The Lambda lives HERE (with the
    // pool) rather than in the control-plane stack, so the pool→Lambda dependency
    // stays one-directional (the control-plane already imports this pool - the
    // reverse would be a cycle). Entry is in the control-plane app dir; it's a
    // tiny, dependency-free handler.
    const preTokenFn = new NodejsFunction(this, "PreTokenFn", {
      entry: join(REPO_ROOT, "apps/control-plane/src/pre-token-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      bundling: { format: "esm" as never, target: "node22" },
    });
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preTokenFn,
      cognito.LambdaVersion.V2_0,
    );

    // Hosted domain, kept ONLY for the `/oauth2/token` endpoint the M2M
    // client-credentials flow calls (scripts/tests). The SPA signs in via in-app
    // SRP and never touches the hosted /login pages, so there's no managed-login
    // branding (the domain uses the default classic version - no ManagedLoginBranding
    // resource needed; the token endpoint doesn't depend on the login UI).
    this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: domainPrefix },
    });

    // Resource server + scope backing M2M tokens.
    const apiScope = new cognito.ResourceServerScope({
      scopeName: M2M_SCOPE,
      scopeDescription: "Access the Agency control-plane API",
    });
    const resourceServer = this.userPool.addResourceServer("ResourceServer", {
      identifier: RESOURCE_SERVER_ID,
      scopes: [apiScope],
    });

    // The web client. The SPA authenticates via in-app SRP (`authFlows.userSrp`),
    // NOT the hosted UI - so there's no Authorization-Code/PKCE redirect and no
    // OAuth callback (disableOAuth below).
    this.userPoolClient = this.userPool.addClient("WebClient", {
      userPoolClientName: "web",
      authFlows: { userSrp: true },
      // Return generic errors regardless of whether the account exists, so the
      // public InitiateAuth/ForgotPassword endpoints can't be used to enumerate
      // valid emails (the pool id + client id are public in the SPA bundle). The
      // app UI already masks this; this closes it at the Cognito API layer too.
      preventUserExistenceErrors: true,
      // The SPA never calls UpdateUserAttributes, and `email` is an authority input
      // (invite matching), so don't grant the client write access to it. Cognito's
      // default is "write all standard attributes", which is more than this app needs.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ preferredUsername: true }),
      // Long-lived login: the SPA holds the refresh token and silently mints new
      // access tokens (in-app SRP; no hosted UI), so a signed-in user isn't bounced
      // to the login form for 30 days. Access/ID tokens stay short (1h) - the refresh
      // token is the durable credential. (Refresh token rotation isn't enabled, so
      // the same token is reused across its validity window.)
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      // No hosted OAuth on the web client: the SPA signs in via in-app SRP (above),
      // never the hosted /oauth2/authorize redirect. disableOAuth drops the dead
      // callback/logout URLs + scope grant the code flow needed. (The `agency/api`
      // scope reaches the API via the pre-token Lambda, not an OAuth scope grant.)
      disableOAuth: true,
    });

    // M2M client (client_credentials) for scripts/tests.
    this.m2mClient = this.userPool.addClient("M2MClient", {
      userPoolClientName: "m2m",
      generateSecret: true,
      authFlows: {},
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, apiScope)],
      },
    });

    const issuer = `https://cognito-idp.${REGION}.amazonaws.com/${this.userPool.userPoolId}`;
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "Issuer", { value: issuer });
    new CfnOutput(this, "M2MClientId", { value: this.m2mClient.userPoolClientId });
    new CfnOutput(this, "WebClientId", { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", {
      value: `${domainPrefix}.auth.${REGION}.amazoncognito.com`,
    });
    new CfnOutput(this, "TokenEndpoint", {
      value: `https://${domainPrefix}.auth.${REGION}.amazoncognito.com/oauth2/token`,
    });
    new CfnOutput(this, "M2MScope", { value: `${RESOURCE_SERVER_ID}/${M2M_SCOPE}` });
  }
}
