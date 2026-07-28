/**
 * A tiny always-on tool: the current date and time. Agents have no clock
 * otherwise (the model's training cutoff is not "now"), so anything date-aware -
 * "latest", "today", "this year", recent events - needs this. Deliberately
 * minimal: no inputs, returns ISO UTC + a human-readable UTC string.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

export function buildTimeTool() {
  return tool({
    name: "get_current_time",
    description:
      "Get the current date and time (UTC). Use this whenever the task involves dates - " +
      "'today', 'latest', 'this year', recent events - instead of assuming a date.",
    inputSchema: z.object({}),
    callback: async () => {
      const now = new Date();
      return { iso: now.toISOString(), utc: now.toUTCString() };
    },
  });
}
