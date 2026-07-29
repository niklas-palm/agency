import { defineConfig } from "vitest/config";

// Only run tests from real source, never from CDK's staged asset copies under
// infra/cdk.out (which duplicate apps/* into the Docker build context).
export default defineConfig({
  test: {
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts", "infra/lib/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/cdk.out/**", "**/dist/**"],
    // The control-plane logs one line per FAILED request (apps/control-plane/src/log.ts), and
    // much of the suite asserts 4xx behaviour - ~250 such lines would bury the output of a test
    // that actually broke. Dropped from the REPORTER only: the code still runs, and log.test.ts
    // asserts on it through a console spy. A 5xx keeps its line, since vitest batches
    // consecutive console writes and it arrives attached to the error dump it belongs with.
    onConsoleLog: (log) => (log.startsWith("request ") ? false : undefined),
  },
});
