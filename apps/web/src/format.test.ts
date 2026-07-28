/**
 * Duration formatting, which is pure arithmetic and was quietly wrong.
 *
 * Both formatters split a duration into minutes + seconds and rounded the SECONDS part
 * on its own, so a value just under a minute boundary rounded up to 60 without carrying
 * into the minute: "1m 60s", "59m 60s", "01:60.0". These land in the p50/p95 stat tiles,
 * every run row, and every line of every trace, so they're worth pinning.
 *
 * Lives in a `.ts` file because the repo collects no `.tsx` tests and has no jsdom -
 * these are functions, not components.
 */
import { describe, it, expect } from "vitest";
import { fmtDuration } from "./views/Monitor.js";
import { elapsed } from "./Trace.js";

describe("fmtDuration", () => {
  it("never renders 60 seconds - it carries into the minute", () => {
    expect(fmtDuration(119_700)).toBe("2m 0s"); // was "1m 60s"
    expect(fmtDuration(3_599_700)).toBe("60m 0s"); // was "59m 60s"
  });

  it("formats sub-minute durations in tenths of a second", () => {
    expect(fmtDuration(5_000)).toBe("5.0s");
    expect(fmtDuration(999)).toBe("1.0s");
    expect(fmtDuration(59_900)).toBe("59.9s");
  });

  it("formats minutes and seconds", () => {
    expect(fmtDuration(60_000)).toBe("1m 0s");
    expect(fmtDuration(90_000)).toBe("1m 30s");
    expect(fmtDuration(3_661_000)).toBe("61m 1s");
  });

  it("shows a dash for nothing, rather than a bogus duration", () => {
    // A legacy or malformed summary row must not render "-1m 5s" or "NaNm NaNs".
    expect(fmtDuration(0)).toBe("-");
    expect(fmtDuration(-5_000)).toBe("-");
    expect(fmtDuration(NaN)).toBe("-");
  });
});

describe("elapsed", () => {
  const t0 = Date.parse("2026-07-27T10:00:00.000Z");
  const at = (ms: number) => new Date(t0 + ms).toISOString();

  it("never renders :60.0 - it carries into the minute", () => {
    expect(elapsed(at(119_970), t0)).toBe("02:00.0"); // was "01:60.0"
    expect(elapsed(at(59_960), t0)).toBe("01:00.0"); // was "00:60.0"
  });

  it("formats mm:ss.s from the session's first event", () => {
    expect(elapsed(at(0), t0)).toBe("00:00.0");
    expect(elapsed(at(1_500), t0)).toBe("00:01.5");
    expect(elapsed(at(83_200), t0)).toBe("01:23.2");
    expect(elapsed(at(600_000), t0)).toBe("10:00.0");
  });

  it("clamps an event that predates the first one", () => {
    // Cursors order events, not timestamps, so an out-of-order ts is possible.
    expect(elapsed(at(-5_000), t0)).toBe("00:00.0");
  });

  it("reads an unparseable timestamp as zero, not NaN", () => {
    expect(elapsed("not-a-date", t0)).toBe("00:00.0");
    expect(elapsed("", t0)).toBe("00:00.0");
  });
});
