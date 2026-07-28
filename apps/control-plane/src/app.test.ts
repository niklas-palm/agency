import { describe, it, expect } from "vitest";
import { isTransient } from "./app.js";

describe("isTransient (error → 503 vs 500 classification)", () => {
  it("treats known transient AWS error names as transient", () => {
    for (const name of [
      "ThrottlingException",
      "ConflictException",
      "ResourceNotReady",
      "ServiceQuotaExceededException",
      "TooManyRequestsException",
      "InternalServerException",
      "TimeoutError",
    ]) {
      expect(isTransient({ name })).toBe(true);
    }
  });

  it("treats the SDK $retryable flag as transient", () => {
    expect(isTransient({ name: "SomethingElse", $retryable: {} })).toBe(true);
    expect(isTransient({ $retryable: { throttling: true } })).toBe(true);
  });

  it("treats 429 / 500 / 503 status codes as transient", () => {
    expect(isTransient({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isTransient({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isTransient({ $metadata: { httpStatusCode: 503 } })).toBe(true);
  });

  it("treats permanent errors as non-transient", () => {
    expect(isTransient({ name: "AccessDeniedException" })).toBe(false);
    expect(isTransient({ name: "ValidationException", $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isTransient({ $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isTransient(new Error("plain"))).toBe(false);
  });

  it("handles non-object input without throwing", () => {
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient("string")).toBe(false);
  });
});
