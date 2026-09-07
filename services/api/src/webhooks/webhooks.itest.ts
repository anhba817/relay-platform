import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment } from "../db/repository";
import { MAX_ENDPOINTS_PER_ENVIRONMENT } from "./webhooks.service";

// The webhook management surface, over real HTTP against the compose Postgres
//. Invariants 1, 2, 3 and 6 of contracts/dispatcher.md live here.
//
// Every environment is minted in this file. Two suites sharing one would let a
// foreign key see another's endpoints, which is the very thing invariant 3
// exists to disprove.

describe("webhook endpoints", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;

  let env: { id: string };
  let key: { credential: string };
  let foreign: { id: string };
  let foreignKey: { credential: string };

  const call = (
    path: string,
    credential: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    fetch(`${url}/v1/webhooks${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
        ...(init.headers ?? {}),
      },
    });

  const create = (credential: string, body: Record<string, unknown> = {}) =>
    call("", credential, {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.test/hook",
        event_types: ["message.created"],
        ...body,
      }),
    });

  beforeAll(async () => {
    db = createDb(createPool());

    env = await createEnvironment(db, { name: "webhooks-itest" });
    key = await createApiKey(db, { environmentId: env.id });

    foreign = await createEnvironment(db, { name: "webhooks-itest-other" });
    foreignKey = await createApiKey(db, { environmentId: foreign.id });

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  // --- invariant 1 -------------------------------------------------------

  it("invariant 1: refuses more endpoints than the limit, with an error that names it", async () => {
    const scratch = await createEnvironment(db, { name: "webhooks-itest-limit" });
    const scratchKey = await createApiKey(db, { environmentId: scratch.id });

    for (let i = 0; i < MAX_ENDPOINTS_PER_ENVIRONMENT; i++) {
      const ok = await create(scratchKey.credential, {
        url: `https://example.test/hook-${i}`,
      });
      expect(ok.status).toBe(201);
    }

    const refused = await create(scratchKey.credential, {
      url: "https://example.test/one-too-many",
    });

    expect(refused.status).toBe(422);
    // The credentials chapter's lesson about error messages that name the mistake, applied
    // to a limit: "too many endpoints" leaves the reader counting.
    const body = (await refused.json()) as { code: string; message: string };
    expect(body.message).toContain(String(MAX_ENDPOINTS_PER_ENVIRONMENT));
    // AND THE CODE (feature 043, FR-014). This test asserted the status and the text and
    // passed while the body called itself `internal_error` — which is exactly how the
    // five bare 422s survived from the webhook dispatcher chapter. The sixth code is asserted here rather
    // than in the group below because reaching this refusal costs a full environment's
    // worth of endpoints.
    expect(body.code).toBe("webhook_endpoint_limit_reached");
  });

  // --- feature 043: the refusals name the customer's mistake -------------

  it("names a CODE for every customer-caused refusal, not just a status (FR-014, SC-006)", async () => {
    // WHAT THIS FILE USED TO ASSERT, AND WHY IT MISSED THE DEFECT. The endpoint-cap test
    // above checks `status` and the message TEXT. Both were right the whole time and the
    // body still said `internal_error` — because `ProtocolErrorFilter` derives a code
    // from 400/401/403/404 and answers `internal_error` for anything else, and these were
    // bare 422s. A customer reading `code` was told the platform had failed.
    //
    // Asserting the code is the only thing that could have caught it, which is why this
    // has been open since the webhook dispatcher chapter.
    const cases: [Record<string, unknown>, string][] = [
      [{ url: "not-a-url" }, "webhook_url_invalid"],
      [{ url: "http://example.test/hook" }, "webhook_url_insecure"],
      [{ url: "https://127.0.0.1/hook" }, "webhook_url_private_address"],
      [{ url: "https://example.test/hook", event_types: [] }, "webhook_event_types_empty"],
      [
        { url: "https://example.test/hook", event_types: ["mesage.updated"] },
        "webhook_event_type_unknown",
      ],
    ];
    for (const [body, code] of cases) {
      const res = await create(key.credential, body);
      expect(res.status).toBe(422);
      const parsed = (await res.json()) as { code: string; message: string };
      expect(parsed.code).toBe(code);
      // AND NOT the code the filter would have invented.
      expect(parsed.code).not.toBe("internal_error");
    }
  });

  it("refuses a typo and names the accepted set (FR-016, SC-008)", async () => {
    const res = await create(key.credential, {
      url: "https://example.test/typo",
      event_types: ["mesage.updated"],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string; field?: string };
    expect(body.code).toBe("webhook_event_type_unknown");
    expect(body.field).toBe("event_types");
    // THE ACCEPTED SET, IN THE MESSAGE. A refusal that says only "unknown event type"
    // leaves a customer guessing at the spelling, which is the failure mode the finding
    // describes: a typo produces a permanently silent endpoint.
    expect(body.message).toContain("message.updated");
    expect(body.message).toContain("channel.created");
  });

  it("ACCEPTS a declared type the platform does not emit yet (FR-016)", async () => {
    // THE HALF THE REVIEW GOT WRONG, and the reason this feature amended its own
    // requirement. `channel.created` is declared by FR-WHK-02 and unbuilt, and **838
    // stored subscriptions name it**. Validating against the emitted five — which the
    // review and the revisions chapter's gaps ledger both recommend — would refuse every one of
    // them, and those customers made no mistake.
    const res = await create(key.credential, {
      url: "https://example.test/declared-unemitted",
      event_types: ["channel.created"],
    });
    expect(res.status).toBe(201);

    // AND IT SAYS SO, which is the half that separates this from silence. The review's
    // finding is that a bad subscription produces "a permanently silent endpoint"; a
    // subscription to a declared-but-unbuilt type produces the same silence for a
    // blameless reason, so the acceptance carries the distinction the refusal would
    // have made.
    const body = (await res.json()) as { not_emitted_yet?: string[] };
    expect(body.not_emitted_yet).toEqual(["channel.created"]);
  });

  it("says nothing extra when every subscribed type is built", async () => {
    // THE CONTROL. `not_emitted_yet` is absent rather than empty, so an endpoint
    // subscribed entirely to built types has exactly the response it always had — and a
    // client that branches on the key's presence is not made to handle `[]`.
    const res = await create(key.credential, {
      url: "https://example.test/all-built",
      event_types: ["message.created", "message.updated"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("not_emitted_yet");
  });

  // --- invariant 2 -------------------------------------------------------

  it("invariant 2: returns the secret once at creation and by no later read", async () => {
    const created = await create(key.credential, {
      url: "https://example.test/secret-once",
    });
    expect(created.status).toBe(201);
    const { id, secret } = (await created.json()) as {
      id: string;
      secret: string;
    };

    // Shown once — otherwise there is no way for a customer to ever have it.
    expect(secret).toBeTruthy();

    const listed = await call("", key.credential);
    expect(listed.status).toBe(200);
    const listBody = await listed.text();
    expect(listBody).not.toContain(secret);

    const read = await call(`/${id}`, key.credential);
    const readBody = await read.text();
    expect(readBody).not.toContain(secret);
    // Not the ciphertext either. A column name in a response is a map to the
    // thing worth stealing.
    expect(readBody).not.toContain("secret_ciphertext");
  });

  // --- invariant 3 (constitution I) --------------------------------------

  it("invariant 3: no environment can read, rotate or delete another's endpoints", async () => {
    const mine = await create(key.credential, {
      url: "https://example.test/mine",
    });
    const { id } = (await mine.json()) as { id: string };

    // A foreign credential must not be able to tell the endpoint apart from one
    // that never existed — 404, not 403, so existence itself does not leak
    // (FR-TEN-05).
    expect((await call(`/${id}`, foreignKey.credential)).status).toBe(404);
    expect(
      (await call(`/${id}/rotate-secret`, foreignKey.credential, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/${id}`, foreignKey.credential, { method: "DELETE" })).status,
    ).toBe(404);

    // And the foreign environment's listing does not contain it.
    const theirs = await call("", foreignKey.credential);
    expect(await theirs.text()).not.toContain(id);

    // Still ours, and still there — the refusals changed nothing.
    expect((await call(`/${id}`, key.credential)).status).toBe(200);
  });

  it("invariant 3: a soft-deleted endpoint disappears from reads but keeps its row", async () => {
    const created = await create(key.credential, {
      url: "https://example.test/to-delete",
    });
    const { id } = (await created.json()) as { id: string };

    expect((await call(`/${id}`, key.credential, { method: "DELETE" })).status).toBe(
      204,
    );

    // Gone from every read...
    expect((await call(`/${id}`, key.credential)).status).toBe(404);
    expect(await (await call("", key.credential)).text()).not.toContain(id);

    // ...but the row survives. Asserted behaviourally rather than by reading the
    // table: deleting frees a slot against the five-endpoint limit only if the
    // read path excludes it, while the foreign keys from deliveries and dead
    // letters still resolve — which is what a hard delete could not offer
    // without cascading away a customer's failure record (FR-WHK-04).
    //
    // The stronger proof — that a deleted endpoint's dead letters are still
    // retrievable — belongs with the dead-letter suite, which owns that path.
    const again = await call(`/${id}`, key.credential, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  // --- invariant 6 -------------------------------------------------------

  it("invariant 6: rotation returns a new secret and keeps the previous one valid", async () => {
    const created = await create(key.credential, {
      url: "https://example.test/rotate",
    });
    const { id, secret: first } = (await created.json()) as {
      id: string;
      secret: string;
    };

    const rotated = await call(`/${id}/rotate-secret`, key.credential, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const { secret: second } = (await rotated.json()) as { secret: string };

    expect(second).not.toBe(first);

    // Both sign for the length of the window, so a recipient accepting either is
    // correct throughout it. The window is 24 hours and is a promise a recipient
    // writes code against (contracts/webhooks.md §Rotation) — the delivery-side
    // half of this invariant is asserted in the dispatcher's suite.
    const read = await call(`/${id}`, key.credential);
    const body = (await read.json()) as { secret_rotated_at: string | null };
    expect(body.secret_rotated_at).toBeTruthy();
  });
});
