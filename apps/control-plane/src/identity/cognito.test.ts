import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what the client is asked to send, and let each test decide the outcome.
const send = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cognito-identity-provider")>(
    "@aws-sdk/client-cognito-identity-provider",
  );
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      send = send;
    },
  };
});

import { CognitoIdentityProvider } from "./cognito.js";
import { UsernameExistsException, AdminCreateUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const provider = new CognitoIdentityProvider("pool-123");

beforeEach(() => send.mockReset());

describe("CognitoIdentityProvider.ensureUser", () => {
  it("creates a new user (verified email, email delivery) and reports 'created'", async () => {
    send.mockResolvedValueOnce({});
    const result = await provider.ensureUser("new@example.com");
    expect(result).toBe("created");
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(AdminCreateUserCommand);
    expect(cmd.input.UserPoolId).toBe("pool-123");
    expect(cmd.input.Username).toBe("new@example.com");
    expect(cmd.input.DesiredDeliveryMediums).toEqual(["EMAIL"]);
    expect(cmd.input.UserAttributes).toContainEqual({ Name: "email_verified", Value: "true" });
  });

  it("swallows UsernameExistsException and reports 'exists' (inviting an existing user is a no-op)", async () => {
    send.mockRejectedValueOnce(
      new UsernameExistsException({ message: "exists", $metadata: {} }),
    );
    await expect(provider.ensureUser("existing@example.com")).resolves.toBe("exists");
  });

  it("propagates other errors (e.g. throttling) so the caller can 5xx/retry", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }));
    await expect(provider.ensureUser("x@example.com")).rejects.toThrow("throttled");
  });
});
