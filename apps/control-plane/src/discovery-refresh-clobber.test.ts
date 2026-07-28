/**
 * A discovery refresh must not revert a concurrent user edit.
 *
 * The refresh path is read → SLOW spec fetch → write, so the window between the
 * read and the write is a network round-trip wide. Writing the whole item there
 * (built from the stale read) silently reverts whatever the user PATCHed meanwhile -
 * including `secret`, `shared`, `managers` and `baseUrl`. These tests drive the sweep
 * against a fake table with an edit landing mid-fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** The stored item, as the "table" holds it. */
type Row = Record<string, unknown>;
let row: Row;

const send = vi.fn();
vi.mock("./ddb.js", () => ({ ddb: { send: (cmd: unknown) => send(cmd) } }));

/** What the sweep's spec fetch returns, and what it does while "fetching". */
let onFetch: () => void = () => {};
vi.mock("./discover-operations.js", () => ({
  refreshDiscovery: vi.fn(async (discovery: { url: string }) => {
    onFetch(); // the concurrent user edit lands here, mid-fetch
    return {
      operations: [{ id: "op-new", name: "new", method: "GET", path: "/new", enabled: true }],
      discovery: { ...discovery, syncedAt: "2026-07-24T12:00:00.000Z", catalog: [] },
    };
  }),
  credentialForSpec: () => undefined,
}));

import { handler } from "./discovery-sweep-lambda.js";

/**
 * A minimal DynamoDB fake: Scan returns the row, and UpdateItem applies exactly the
 * three SET fields the discovery writer names, honouring its ConditionExpression on
 * `discovery.url`. Modelling only what's used keeps the fake honest about the thing
 * under test - that the write touches nothing else.
 */
function fakeTable() {
  send.mockImplementation(async (cmd: { input: Row; constructor: { name: string } }) => {
    const kind = cmd.constructor.name;
    if (kind === "ScanCommand") return { Items: [row] };
    if (kind === "UpdateCommand") {
      const vals = cmd.input.ExpressionAttributeValues as Row;
      const expected = vals[":expectedUrl"];
      const current = (row.discovery as { url?: string } | undefined)?.url;
      if (current !== expected) {
        throw Object.assign(new Error("stale"), { name: "ConditionalCheckFailedException" });
      }
      row.operations = vals[":ops"];
      row.discovery = vals[":disc"];
      row.updatedAt = vals[":u"];
      return {};
    }
    throw new Error(`unexpected ${kind}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  onFetch = () => {};
  row = {
    orgId: "org-A",
    id: "int-1",
    name: "petstore",
    createdBy: "user-A",
    shared: false,
    managers: ["user-B"],
    secret: "sk_live_original",
    baseUrl: "https://api.example.com",
    auth: { kind: "bearer" },
    operations: [{ id: "op-old", name: "old", method: "GET", path: "/old", enabled: true }],
    discovery: { url: "https://api.example.com/openapi.json", syncedAt: "2026-07-23T00:00:00.000Z", catalog: [] },
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
  fakeTable();
});

describe("discovery sweep vs a concurrent PATCH", () => {
  it("refreshes the operations without touching fields it doesn't own", async () => {
    await handler();
    expect((row.operations as { id: string }[])[0]!.id).toBe("op-new");
    expect(row.secret).toBe("sk_live_original");
    expect(row.managers).toEqual(["user-B"]);
    expect(row.shared).toBe(false);
  });

  it("does not revert a user edit that landed during the spec fetch", async () => {
    // Mid-fetch the user shares the integration, re-points its baseUrl, rotates the
    // secret and drops a manager. A whole-item Put from the stale read would undo
    // ALL of it - the secret rollback being the worst: the proxy would keep sending
    // a credential the user believed they had rotated away.
    onFetch = () => {
      row.shared = true;
      row.baseUrl = "https://api2.example.com";
      row.secret = "sk_live_rotated";
      row.managers = [];
    };

    await handler();

    expect(row.shared).toBe(true);
    expect(row.baseUrl).toBe("https://api2.example.com");
    expect(row.secret).toBe("sk_live_rotated");
    expect(row.managers).toEqual([]);
    // The refresh's own field still lands - it's not in conflict with the edit.
    expect((row.operations as { id: string }[])[0]!.id).toBe("op-new");
  });

  it("drops its result when the edit re-pointed the integration at a different spec", async () => {
    // Now the edit DOES conflict: the operations we just fetched describe an upstream
    // the user no longer asked for, so applying them would grant capabilities from
    // the wrong API. The conditional write refuses.
    onFetch = () => {
      row.discovery = { url: "https://other.example.com/openapi.json", syncedAt: "x", catalog: [] };
      row.operations = [{ id: "op-user", name: "user", method: "GET", path: "/u", enabled: true }];
    };

    await handler();

    expect((row.operations as { id: string }[])[0]!.id).toBe("op-user"); // untouched
    expect((row.discovery as { url: string }).url).toBe("https://other.example.com/openapi.json");
  });

  it("drops its result when the edit switched the integration to manual authoring", async () => {
    // `discovery` is gone entirely, so the condition on discovery.url can't hold.
    onFetch = () => {
      delete row.discovery;
      row.operations = [{ id: "op-manual", name: "manual", method: "GET", path: "/m", enabled: true }];
    };

    await handler();

    expect(row.discovery).toBeUndefined(); // not resurrected
    expect((row.operations as { id: string }[])[0]!.id).toBe("op-manual");
  });
});
