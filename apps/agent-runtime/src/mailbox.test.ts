import { describe, it, expect, vi, afterEach } from "vitest";
import { BeforeModelCallEvent } from "@strands-agents/sdk";
import { enqueueMessage, takePending, InjectionPlugin, MAILBOX_CAP } from "./mailbox.js";

/** Minimal fake agent capturing the hook + the event type it registered under,
 *  and exposing a mutable message list. */
function fakeAgent() {
  let hook: ((event: unknown) => void) | undefined;
  let hookType: unknown;
  const messages: Array<{ role: string; content: Array<{ text: string }> }> = [];
  return {
    messages,
    get hookType() {
      return hookType;
    },
    addHook: (type: unknown, cb: (event: unknown) => void) => {
      hookType = type;
      hook = cb;
    },
    fireBeforeModelCall: () => hook?.({ type: "beforeModelCallEvent" }),
  };
}

// The mailbox is a single module global (one session per microVM), so clear it
// between tests to keep them independent.
afterEach(() => {
  takePending();
});

describe("mid-turn injection", () => {
  it("injects a queued message into agent.messages on the next model call", () => {
    const onInjected = vi.fn();
    const agent = fakeAgent();
    new InjectionPlugin(onInjected).initAgent(agent as never);

    enqueueMessage("hello mid-turn");
    agent.fireBeforeModelCall();

    expect(agent.messages).toHaveLength(1);
    expect(agent.messages[0]!.role).toBe("user");
    expect(agent.messages[0]!.content[0]!.text).toContain("hello mid-turn");
    expect(onInjected).toHaveBeenCalledWith("hello mid-turn");
  });

  it("drains the mailbox so a message is injected exactly once", () => {
    const agent = fakeAgent();
    new InjectionPlugin(vi.fn()).initAgent(agent as never);

    enqueueMessage("once");
    agent.fireBeforeModelCall();
    agent.fireBeforeModelCall();

    expect(agent.messages).toHaveLength(1);
  });

  it("injects multiple queued messages in FIFO order in one drain", () => {
    const onInjected = vi.fn();
    const agent = fakeAgent();
    new InjectionPlugin(onInjected).initAgent(agent as never);

    enqueueMessage("first");
    enqueueMessage("second");
    agent.fireBeforeModelCall();

    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[0]!.content[0]!.text).toContain("first");
    expect(agent.messages[1]!.content[0]!.text).toContain("second");
    expect(onInjected.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
  });

  it("wraps the injected text in an <injected-message> marker", () => {
    const agent = fakeAgent();
    new InjectionPlugin(vi.fn()).initAgent(agent as never);
    enqueueMessage("hi");
    agent.fireBeforeModelCall();
    expect(agent.messages[0]!.content[0]!.text).toMatch(/<injected-message>[\s\S]*hi[\s\S]*<\/injected-message>/);
  });

  it("injects messages queued between model calls on the next call", () => {
    const agent = fakeAgent();
    new InjectionPlugin(vi.fn()).initAgent(agent as never);

    enqueueMessage("round1");
    agent.fireBeforeModelCall();
    expect(agent.messages).toHaveLength(1);

    // A new message arrives during the turn; it lands on the next model call.
    enqueueMessage("round2");
    agent.fireBeforeModelCall();
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[1]!.content[0]!.text).toContain("round2");
  });

  it("a model call with an empty mailbox injects nothing", () => {
    const agent = fakeAgent();
    new InjectionPlugin(vi.fn()).initAgent(agent as never);
    agent.fireBeforeModelCall();
    expect(agent.messages).toHaveLength(0);
  });

  it("registers its drain hook under the BeforeModelCallEvent type (fires before each model call)", () => {
    // The whole feature hinges on draining the mailbox BEFORE the model runs, so
    // assert the plugin keys its hook off BeforeModelCallEvent - not just that the
    // symbol exists. Catches both an SDK rename and the plugin wiring the wrong event.
    const agent = fakeAgent();
    new InjectionPlugin(vi.fn()).initAgent(agent as never);
    expect(agent.hookType).toBe(BeforeModelCallEvent);
  });

  it("takePending returns and removes queued messages (turn-end drain)", () => {
    enqueueMessage("late-1");
    enqueueMessage("late-2");
    // Simulates the turn-end drain: messages that arrived too late to be injected
    // are taken so they can be re-dispatched, not silently dropped.
    expect(takePending()).toEqual(["late-1", "late-2"]);
    // A subsequent take is empty (they were removed).
    expect(takePending()).toEqual([]);
  });

  it("enqueueMessage returns true under the cap and false once full (flood protection)", () => {
    for (let i = 0; i < MAILBOX_CAP; i++) {
      expect(enqueueMessage(`m${i}`)).toBe(true);
    }
    // At capacity: further messages are rejected, not silently unbounded.
    expect(enqueueMessage("overflow")).toBe(false);
    const taken = takePending();
    expect(taken).toHaveLength(MAILBOX_CAP);
    expect(taken).not.toContain("overflow");
  });
});
