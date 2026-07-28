/**
 * A tiny sample downstream API - a pet store - used to demo + test Agency
 * integrations end-to-end. It is deliberately trivial and self-contained (an
 * in-memory store, one bearer credential) so an agent, via the integrations proxy,
 * can list/create/read pets and we can prove the whole path works: the proxy holds
 * the credential, the agent never sees it, and only the declared operations are
 * reachable.
 *
 * The operations here mirror the manifest a user would register as an integration
 * (see the local-dev seed + docs/integrations.md):
 *   GET  /pets          listPets
 *   POST /pets          createPet   { name, kind }
 *   GET  /pets/{id}     getPet
 *
 * It also serves its own OpenAPI document at `GET /openapi.json` - behind the SAME
 * bearer gate as everything else, which is the common real-world case and what lets
 * the E2E prove auto-discovery authenticates the spec fetch with the integration's
 * credential (an unauthenticated fetch would 403).
 *
 * Auth: a single bearer token in `Authorization: Bearer <token>`, read from
 * SAMPLE_API_TOKEN (empty ⇒ auth disabled, for a frictionless local start). This is
 * the credential the integration stores and the proxy injects - the agent supplies
 * nothing.
 */
import { Hono } from "hono";

interface Pet {
  id: string;
  name: string;
  kind: string;
}

export function buildSampleApp(): Hono {
  const app = new Hono();

  // Seed a couple of pets so a fresh GET returns something meaningful.
  const pets = new Map<string, Pet>([
    ["1", { id: "1", name: "Rex", kind: "dog" }],
    ["2", { id: "2", name: "Whiskers", kind: "cat" }],
  ]);
  let nextId = 3;

  const requiredToken = process.env.SAMPLE_API_TOKEN ?? "";

  // Bearer-token gate on everything except the health check. When no token is
  // configured, auth is disabled (local convenience) - but a configured token is
  // strictly enforced, which is what proves the proxy injects the right credential.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || !requiredToken) return next();
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${requiredToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // The API's own OpenAPI document - behind the bearer gate (above), so auto-discovery
  // must send the integration credential to fetch it. Paths are relative to the base.
  app.get("/openapi.json", (c) =>
    c.json({
      openapi: "3.0.0",
      info: { title: "Pet Store", version: "1.0.0" },
      paths: {
        "/pets": {
          get: { operationId: "listPets", summary: "List all pets" },
          post: { operationId: "createPet", summary: "Create a pet" },
        },
        "/pets/{id}": { get: { operationId: "getPet", summary: "Get one pet by id" } },
      },
    }),
  );

  app.get("/pets", (c) => c.json({ pets: [...pets.values()] }));

  app.post("/pets", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; kind?: unknown } | null;
    if (!body || typeof body.name !== "string" || typeof body.kind !== "string") {
      return c.json({ error: "name and kind are required strings" }, 400);
    }
    const pet: Pet = { id: String(nextId++), name: body.name, kind: body.kind };
    pets.set(pet.id, pet);
    return c.json(pet, 201);
  });

  app.get("/pets/:id", (c) => {
    const pet = pets.get(c.req.param("id"));
    return pet ? c.json(pet) : c.json({ error: "not found" }, 404);
  });

  return app;
}
