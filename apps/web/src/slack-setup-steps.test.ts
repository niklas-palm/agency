/**
 * The state → step mapping for the Slack setup panel.
 *
 * This exists because getting it wrong is invisible everywhere else: typecheck passes, every
 * server-side test passes, and the panel still renders - it just renders a step with no way
 * forward. The original mapping put `url_verified` at step 0 while the credential form renders
 * only from step 1, so the flow could not be completed at all.
 *
 * No jsdom in this project (see CONTRIBUTING.md), which is why `stepOf` is exported as a pure
 * function rather than tested through the component.
 */
import { describe, expect, it } from "vitest";
import { stepOf } from "./SlackSetup.js";

/** Mirrors the render gates in SlackSetup: the credential form needs step >= 1, channels >= 2. */
const showsCredentialForm = (step: number) => step >= 1;
const showsChannelForm = (step: number) => step >= 2;

describe("stepOf", () => {
  /**
   * THE regression test. `url_verified` is the state a real user reaches - Slack has called our
   * webhook, so the app exists and the next act is to install and paste the token. If it maps to
   * step 0 the credential form never renders and setup is a dead end.
   */
  it("shows the credential form once Slack has reached us", () => {
    expect(showsCredentialForm(stepOf("url_verified"))).toBe(true);
  });

  it("does not show the credential form before the app exists", () => {
    expect(showsCredentialForm(stepOf("manifest_ready"))).toBe(false);
  });

  it("offers the credential form in every state where credentials are still needed", () => {
    for (const state of ["url_verified", "needs_bot_token"] as const) {
      expect(showsCredentialForm(stepOf(state)), state).toBe(true);
    }
  });

  it("only offers channels once the workspace is verified", () => {
    expect(showsChannelForm(stepOf("manifest_ready"))).toBe(false);
    expect(showsChannelForm(stepOf("url_verified"))).toBe(false);
    expect(showsChannelForm(stepOf("verified"))).toBe(true);
    expect(showsChannelForm(stepOf("live"))).toBe(true);
  });

  /** Every state must be reachable on the tracker, and the order must never go backwards. */
  it("advances monotonically through the real sequence", () => {
    const steps = (["manifest_ready", "url_verified", "verified", "live"] as const).map(stepOf);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(steps[0]).toBe(0);
    expect(steps.at(-1)).toBe(2);
  });
});
