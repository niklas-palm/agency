/**
 * Mid-turn message injection.
 *
 * When a new invocation arrives while a turn is already running, we can't safely
 * start a second concurrent turn (a Strands Agent mutates its own message list
 * and isn't concurrency-safe). Instead we drop the message into a mailbox. A
 * `BeforeModelCallEvent` hook - registered on the agent via the InjectionPlugin -
 * drains the mailbox and appends the queued messages to `agent.messages` right
 * before the next model call. The running agent therefore sees the new message
 * mid-turn, at its next reasoning step.
 *
 * This is safe because the hook runs synchronously inside the single running
 * turn's loop (no concurrent Agent mutation), and messages pushed directly to
 * `agent.messages` do not re-fire MessageAddedEvent, so there's no hook recursion.
 *
 * The mailbox is a single module-global array: AgentCore runs each session ID in
 * its own isolated microVM, so this process only ever serves one session - there
 * is nothing to key by.
 */
import { BeforeModelCallEvent, type LocalAgent, Message, TextBlock } from "@strands-agents/sdk";

let mailbox: string[] = [];

/** Max messages held at once, so a flooded session can't grow unbounded. */
export const MAILBOX_CAP = 100;

/**
 * Queue a message for injection into the running turn. Returns false (without
 * enqueuing) if the mailbox is at capacity, so the caller can apply backpressure
 * rather than falsely acking an unbounded flood.
 */
export function enqueueMessage(text: string): boolean {
  if (mailbox.length >= MAILBOX_CAP) return false;
  mailbox.push(text);
  return true;
}

/**
 * Take and remove all queued messages. Used both by the injection hook (mid-turn)
 * and at turn end to reclaim any messages that arrived too late to be injected
 * into the finishing turn, so they can be re-dispatched rather than dropped.
 */
export function takePending(): string[] {
  const taken = mailbox;
  mailbox = [];
  return taken;
}

/**
 * Strands plugin that injects queued mailbox messages before each model call.
 * `onInjected` is invoked for each injected message so the caller can record it
 * to the trajectory.
 */
export class InjectionPlugin {
  readonly name = "agency:injection";

  constructor(private readonly onInjected: (text: string) => void) {}

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeModelCallEvent, () => {
      for (const text of takePending()) {
        agent.messages.push(
          new Message({
            role: "user",
            content: [new TextBlock(`<injected-message>\n${text}\n</injected-message>`)],
          }),
        );
        this.onInjected(text);
      }
    });
  }
}
