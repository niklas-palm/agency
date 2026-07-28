# Contributing

Thanks for looking. This is a personal project, so before writing code: **open an issue
first** for anything beyond a small fix. It's a fast way to find out whether a change fits the
design, and it saves you building something I'd ask you to unwind.

Security issues do **not** go in issues or pull requests - see [SECURITY.md](SECURITY.md).

## Getting set up

```bash
npm install
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_SESSION_TOKEN=…
docker compose up --build
```

Node >= 22, Docker, and AWS credentials with Bedrock model access in `eu-north-1` (the region
is load-bearing - see [docs/local-dev.md](docs/local-dev.md)). Bedrock is the one thing that
can't run locally; everything else does.

## The standing rules

These aren't style preferences. They're the reason this codebase is still legible, and a
change that breaks one will get comments. `CLAUDE.md` carries the same rules in fuller form
(it's the entry point for AI coding agents, and the most complete description of how the
system fits together) - the two are kept in step, so if you change a rule, change both.

1. **Keep the docs current, in the same change.** If you change how something works, update
   the relevant `docs/*.md` and `CLAUDE.md` alongside the code. This explicitly includes the
   **OpenAPI spec** (`packages/shared/src/openapi.ts`) and the **coding-agent skill**
   (`packages/shared/src/skill.ts`): any API surface change - endpoint, wire type, scope,
   model, auth - must reach both, so the machine-readable contract we serve to clients can't
   drift from the code. Check the whole repo, not your diff: the staleness is usually in a
   file you didn't touch (a topology claim, a stack or table list, a retention number, the
   test count in `README.md`).
2. **Comments describe the *current* implementation, never a past one.** A comment explaining
   why the code used to be different is worse than no comment.
3. **Prefer the simpler solution.** Before adding code, ask whether there's a smaller way.
   Readability and clear structure win over cleverness. Don't over-engineer: no abstraction,
   configuration, or generality for a case nobody has asked for, and no defensive code for a
   scenario that can't happen. There's **no backwards-compatibility requirement** here unless
   a specific stored record or deployed client demands one.
4. **No dead or stale code.** Delete it, don't comment it out. If a workaround stops being
   necessary, remove it.
5. **Respect the seams.** New cross-boundary behavior goes through the existing interfaces
   (`AgentInvoker`, `ScheduleProvisioner`, `IdentityProvider`, `DiscoveryProvider`, the MODELS
   map, the shared wire types). The local stack must stay a faithful replica of prod.
6. **Tools never throw.** An agent tool returns `{ error, hint }` so the model can adapt. A
   thrown exception reaches the model as an opaque stack trace instead of something it can act
   on.
7. **Verify end to end.** After a non-trivial change run `npm run e2e:local`. The E2E is the
   contract - it creates an agent, invokes it, polls the trajectory, injects mid-turn, and
   asserts the injection was seen.

## Before you open a pull request

```bash
npm run typecheck     # must be clean across all workspaces
npm test              # the full suite must pass
npm run e2e:local     # for anything touching the runtime, invoke, or trajectory paths
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run typecheck && npm test` on every PR.
It deliberately does **not** run the E2E - that invokes real Bedrock models, so it needs
credentials and costs money. Run `npm run e2e:local` yourself for anything touching the
runtime, invoke, or trajectory paths.

Infrastructure changes: run `cdk synth` and include what `cdk diff` shows. If you changed
anything under `apps/agent-runtime/`, note that it rebuilds the container image - so the asset
hash changes and the runtime redeploys.

## Tests

**A bug fix comes with a regression test.** More specifically, a test that *fails without your
fix* - it's worth reverting the fix briefly to confirm the test actually catches it. A test
that passes for the wrong reason is worse than no test, and this repo has had several
(a truncation test that tripped a different cap than the one under test; a parity test that
passed while both implementations were wrong the same way).

Conventions:

- Tests live next to the code as `*.test.ts`, run by Vitest from the repo root.
- Only `.ts` tests are collected - there's no jsdom, so extract pure logic and test that
  rather than rendering components.
- Prefer a test that pins the *reason* for the code over one that pins its current output.
  The good tests here read as an explanation of a past failure.
- Mock at the repository boundary (`repo/*.ts`), not the AWS SDK, and make the fake faithful:
  mocking a conditional write as always-succeeding hides exactly the bug the condition exists
  to prevent.

## Commit messages

Write what changed and **why it mattered** - the failure mode, not just the diff. Present
tense, lowercase subject, no trailing period. The history is meant to be readable as an
account of the reasoning; `git log` here is documentation.

## This repository is public - what not to commit

A commit message can't be retracted by a later commit; the only remedy is a history rewrite.
So treat everything you write - code, comments, commit messages, test fixtures - as published.
Don't include:

- **Anything that isn't yours to publish.** No third-party names, emails, usernames or
  handles, and no real user data, ids or org names read out of a live system. Describe the
  behaviour, not the person or the record. (This isn't hypothetical: one commit message
  containing a colleague's email is why this repo's history was squashed before release.)
- **Internal or employer-specific references.** No internal tool names, codenames, ticket
  ids, wiki links or internal hostnames. State the constraint, drop the source.
- **Live deployment identifiers or credentials.** No AWS account ids, ARNs, API Gateway ids,
  CloudFront domains, Cognito ids or bucket names in tracked files. Real values live in
  gitignored config (`infra/cdk.context.json`) or come from stack outputs at deploy time.
  Fixtures must be obviously synthetic - `agpat_test_token_000000`, `example.com`,
  `000000000000`.
- **Speculation about unfixed weaknesses.** Accepted trade-offs belong in
  [SECURITY.md](SECURITY.md), stated deliberately with their mitigations. A "this is probably
  exploitable if you…" aside in a commit message is a free tip for an attacker. Found
  something real? See SECURITY.md - **not** an issue or a PR.

Rule of thumb: *would you be comfortable if this line were quoted back to you publicly, out
of context?*

## Code style

TypeScript throughout, strict. No formatter is enforced - match the file you're in. Comments
explain *why*, not *what*; the code already says what. The existing prose density is
deliberate: where something is subtle, say so and say why.

## Licensing

Contributions are accepted under [Apache-2.0](LICENSE), matching the project. Don't paste in
code you don't have the right to relicense - and if you adapt third-party material, keep its
attribution (see [NOTICE](NOTICE)).
