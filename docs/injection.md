# Mid-turn message injection

**Goal:** when a new message arrives on a session whose agent is *already working*, the
running agent should see it mid-task - not after the current turn ends.

## Why this is subtle

A Strands `Agent` mutates its own message list as it runs and is **not concurrency-safe**,
so we cannot simply start a second turn on the same Agent. (The reference project
kundvagn3.0 avoided this entirely by serializing turns - a new message waits for the
current turn to finish. It documented true mid-turn injection as a deferred idea in
a prior design that was blocked by its own snapshot-persistence constraints.)

## How we do it

Two pieces in `apps/agent-runtime/src/mailbox.ts`:

1. **A mailbox** (a single `string[]`). When the invoke handler sees that a turn is already
   running, it pushes the message to the mailbox and returns `{ status: "injected" }`
   instead of starting a new turn. The mailbox isn't keyed by session: AgentCore runs each
   session ID in its own isolated microVM, so the process only ever serves one session.
2. **A Strands `BeforeModelCallEvent` hook** (registered via the `InjectionPlugin`). Before
   each model call inside the running turn, the hook drains the mailbox and appends the
   queued message(s) to `agent.messages`. The agent therefore sees the new message at its
   next reasoning step, within the same turn.

This is safe because the hook runs **synchronously inside the single running turn's loop**
(no concurrent Agent mutation), and messages pushed directly to `agent.messages` do not
re-fire `MessageAddedEvent`, so there's no hook recursion. Our history lives in the warm
microVM's memory with no verbatim snapshot, so the persistence-bloat problem that blocked
the reference project does not apply.

## Client-visible contract

`POST /invoke` returns `status: "triggered"` when it started a fresh turn,
`status: "injected"` when the message was injected into a running turn, or
`status: "rejected"` when the session's mailbox is at capacity (flood protection -
`MAILBOX_CAP` messages) and the message was not accepted (back off and retry). Each
injected message is also recorded as an `injected` trajectory event, so a poller sees
exactly when it landed.

## Late messages and turn end

A message can arrive after a turn's final model call, when no further
`BeforeModelCallEvent` will fire. Such a message is still acked `injected`, so it must be
consumed: at turn end the runtime drains the mailbox and, if non-empty, runs the pending
message(s) as a follow-up turn on the same warm agent. The loop is bounded not by a turn
count (which would drop already-acked work) but by the mailbox cap - once `MAILBOX_CAP`
messages are pending, further intake is refused with `rejected` - and ultimately by the
microVM's `maxLifetime`. On the success path a message accepted as `injected` is guaranteed
to run: it is either injected mid-turn by the hook, or - if it arrives after the final model
call, even during the `session_end` write - caught by the loop's drain (it drains *before*
the terminal write, and re-drains *after* it, re-running any straggler) and run as a
follow-up turn. `session_end` is therefore written exactly once, only when the mailbox is
confirmed empty.

**Known residuals** (both narrow, deliberately not fixed - see CLAUDE.md):
- *Poll-observability window.* A straggler arriving *during* the `session_end` write runs and
  is durably recorded (under a second `session_end`), but a client polling in that
  ~write-latency window can read the first `session_end` as terminal and stop, missing the
  follow-up turn's output. Fully closing it needs a turn-state machine (the terminal write is
  async and `working` must stay true across it to serialize turns).
- *Error-path drop.* If a turn errors, the warm agent is nulled (poisoned) and the `finally`
  clears the mailbox, so a message acked `injected` during the `error` write is dropped rather
  than run - intentional: there's no context to run it against, and keeping it would risk
  leaking into a different session's turn on the shared local runtime.

## Verified

The E2E (`scripts/e2e.ts`) triggers a long-running task, injects a second message while the
agent works, and asserts (a) the ack is `injected`, (b) an `injected` trajectory event
appears, and (c) the agent acts on the injected instruction. Passes locally and on AWS.
