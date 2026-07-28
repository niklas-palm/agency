import { defineConfig } from "vitest/config";

// Only run tests from real source, never from CDK's staged asset copies under
// infra/cdk.out (which duplicate apps/* into the Docker build context).
export default defineConfig({
  test: {
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/cdk.out/**", "**/dist/**"],
  },
});
