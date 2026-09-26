import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
} from "../db/repository";
import { ensureBucket, storeConfig } from "../media/store";
import { presign } from "../media/presign";

// THE SEAM THE ONLY SERVICE THAT READS THE BYTES TALKS OVER.
//
// Two routes, and the isolation question splits the way `usage.itest.ts` split it: no
// tenant credential reaches either, and neither route takes a tenant as an input at all.
// The second half is the stronger one and it is asserted by CONSTRUCTION below —
// `/internal/media/pending` has no parameter to forge, so the test is that two tenants'
// objects come back from one unparameterised call.
//
// THE STORE IS REAL, because FR-MED-04's *"deletion of the object, retaining only the
// audit record"* is two claims in two places and a suite that mocked the store could
// only check one of them.
const WORKER = "rk_svc_media_worker_itest_0123456789abcdef";
/** The dispatcher's, kept so the refusal is tested in both directions. One direction
 * proves a filter exists; two prove it discriminates. */
const DISPATCHER = "rk_svc_media_dispatcher_itest_0123456789";

describe("the media worker's seam", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let envA: { id: string };
  let envB: { id: string };
  let keyA: string;
  let userToken: string;
  const store = storeConfig();

  const slot = async (credential: string, bytes = 1024): Promise<string> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "p.png",
        mime_type: "image/png",
        bytes,
      }),
    });
    expect(res.status, "the slot route did not issue an id to test with").toBe(201);
    return ((await res.json()) as { media_id: string }).media_id;
  };

  const pending = (credential?: string, query = "") =>
    fetch(`${url}/internal/media/pending${query}`, {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
    });

  const verdict = (id: string, body: unknown, credential?: string) =>
    fetch(`${url}/internal/media/${id}/verdict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const ready = { verdict: "ready", verified_bytes: 1024, verified_type: "image/png" };

  /** PUT THIS ROW AT THE HEAD OF THE QUEUE, because the lane's backlog is longer than
   * any batch.
   *
   * THE ROUTE IS OLDEST-FIRST AND THE LANE HOLDS 3,292 PENDING ROWS, the oldest from a
   * week ago. So a slot taken a millisecond ago is row 3,293 of a 200-row page and the
   * first version of these two tests asserted `toContain` against a list that could
   * never hold it — a test failing for the lane's reason rather than the route's.
   *
   * The fixture moves its own rows' sort key rather than the route moving its order.
   * Scoped to one id, and `afterAll` removes every row these two environments own, so
   * the next run's head is not this run's leftovers. */
  const backdate = async (id: string): Promise<void> => {
    await pool.query(
      // INSIDE FR-MED-10's WINDOW, AT THE HEAD OF IT. The batch excludes anything
      // older than 24 hours, so a fixture pinned to 2000-01-01 — which this was — is
      // invisible to the sweep rather than first in it.
      "update media_objects set created_at = greatest(" +
        "(select coalesce(min(created_at), now()) from media_objects " +
        " where created_at > now() - interval '24 hours') - interval '1 second', " +
        "now() - interval '23 hours 30 minutes') where id = $1",
      [id],
    );
  };

  const objectKeyOf = async (id: string): Promise<string> => {
    const rows = await pool.query<{ object_key: string }>(
      "select object_key from media_objects where id = $1",
      [id],
    );
    return rows.rows[0]!.object_key;
  };

  const stateOf = async (id: string): Promise<string> => {
    const rows = await pool.query<{ state: string }>(
      "select state from media_objects where id = $1",
      [id],
    );
    return rows.rows[0]!.state;
  };

  const storeHas = async (key: string): Promise<boolean> => {
    const res = await fetch(
      presign({
        method: "HEAD",
        ...store,
        endpoint: store.internalEndpoint,
        key,
        expiresIn: 60,
      }),
      { method: "HEAD" },
    );
    return res.ok;
  };

  const upload = async (key: string, bytes: string): Promise<void> => {
    const res = await fetch(
      presign({
        method: "PUT",
        ...store,
        endpoint: store.internalEndpoint,
        key,
        expiresIn: 60,
      }),
      { method: "PUT", body: bytes },
    );
    expect(res.status, "the fixture could not put bytes in the store").toBe(200);
  };

  const pool = createPool();

  beforeAll(async () => {
    process.env["RELAY_INTERNAL_CREDENTIAL_WORKER"] = WORKER;
    process.env["RELAY_INTERNAL_CREDENTIAL"] = DISPATCHER;

    await ensureBucket(store);
    db = createDb(pool);

    envA = await createEnvironment(db, { name: `verdict-itest-${randomUUID()}` });
    envB = await createEnvironment(db, {
      name: `verdict-itest-other-${randomUUID()}`,
    });
    keyA = (await createApiKey(db, { environmentId: envA.id })).credential;
    const secret = (await environmentSigningSecret(db, envA.id))!.signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "verdict-user",
        environmentId: envA.id,
        ttlSeconds: 3600,
      })
    ).token;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    // SCOPED TO THIS SUITE'S OWN TENANTS, which is the rule `check-lane-scope.py` was
    // written for. Without it the backdated rows stay at the head of every later run's
    // batch and the 200-row cap eventually hides the next run's own fixtures — the
    // same defect this suite just worked around, accumulating one run at a time.
    await pool.query("delete from media_objects where environment_id = any($1)", [
      [envA.id, envB.id],
    ]);
    await pool.end();
  });

  // ── WHO MAY CALL IT ─────────────────────────────────────────────────────────────

  describe("who may reach the seam", () => {
    it("accepts the worker's own credential", async () => {
      const res = await pending(WORKER);
      expect(res.status).toBe(200);
    });

    it("refuses the DISPATCHER's credential, which is the point of naming services", async () => {
      // FR-044's discrimination, asked of the route that reads customer bytes. Both are
      // platform credentials and one class-level `@Accepts("platform")` would have let
      // this through — which is why the guard refuses to compile the bare form.
      const res = await pending(DISPATCHER);
      expect(res.status).toBe(403);
      // `wrong_credential_service`, NOT `wrong_credential_type`. The first version of
      // this assertion said the latter and the route answered 403 anyway — the class is
      // right and the SERVICE is wrong, which is a different refusal with a different
      // code, and asserting the status alone would have passed on either.
      expect(((await res.json()) as { code: string }).code).toBe(
        "wrong_credential_service",
      );
    });

    it("refuses a tenant API key with 403", async () => {
      expect((await pending(keyA)).status).toBe(403);
    });

    it("refuses an end-user token with 403", async () => {
      expect((await pending(userToken)).status).toBe(403);
    });

    it("refuses no credential with 401", async () => {
      expect((await pending(undefined)).status).toBe(401);
    });

    it("never quotes the credential back (NFR-SEC-06)", async () => {
      const body = await (await pending(keyA)).text();
      expect(body).not.toContain(keyA);
      expect(body).not.toContain(WORKER);
    });
  });

  // ── WHAT THE READ SIDE IS (T012) ────────────────────────────────────────────────

  describe("the batch", () => {
    it("takes no tenant parameter, so one call sees every tenant's objects", async () => {
      // THE ISOLATION PROPERTY STATED AS THE THING IT IS. Everywhere else in this
      // platform a cross-tenant read is the defect; here it is the contract, because
      // one worker serves every environment. What makes that safe is not a predicate,
      // it is that there is no parameter to forge — so this test asserts the absence
      // by showing two tenants arriving from one unparameterised call.
      const keyB = (await createApiKey(db, { environmentId: envB.id })).credential;
      const a = await slot(keyA);
      const b = await slot(keyB);
      await backdate(a);
      await backdate(b);

      const res = await pending(WORKER, "?limit=200");
      const body = (await res.json()) as { objects: { id: string }[] };
      const ids = body.objects.map((o) => o.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    });

    it("returns the declaration, which is the thing the worker checks", async () => {
      const id = await slot(keyA, 4096);
      await backdate(id);
      const body = (await (await pending(WORKER, "?limit=200")).json()) as {
        objects: {
          id: string;
          object_key: string;
          mime_type: string;
          declared_bytes: number;
        }[];
      };
      const row = body.objects.find((o) => o.id === id)!;
      expect(row.mime_type).toBe("image/png");
      expect(row.declared_bytes).toBe(4096);
      expect(row.object_key.length).toBeGreaterThan(0);
    });

    it("caps the batch at 200 however large a limit is asked for", async () => {
      const res = await pending(WORKER, "?limit=100000");
      const body = (await res.json()) as { objects: unknown[] };
      expect(body.objects.length).toBeLessThanOrEqual(200);
    });

    it("drops an object once a verdict has been reached on it", async () => {
      const id = await slot(keyA);
      await backdate(id);
      expect((await verdict(id, ready, WORKER)).status).toBe(200);
      const body = (await (await pending(WORKER, "?limit=200")).json()) as {
        objects: { id: string }[];
      };
      expect(body.objects.map((o) => o.id)).not.toContain(id);
    });
  });

  // ── THE VERDICT (T013, T014) ────────────────────────────────────────────────────

  describe("the verdict", () => {
    it("moves a pending object to ready and records what the probe found", async () => {
      const id = await slot(keyA);
      const res = await verdict(
        id,
        { ...ready, width: 1920, height: 1080 },
        WORKER,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ applied: true, state: "ready" });

      const rows = await pool.query<{
        width: number;
        height: number;
        verified_bytes: string;
        verified_type: string;
      }>(
        "select width, height, verified_bytes, verified_type from media_objects where id = $1",
        [id],
      );
      expect(rows.rows[0]!.width).toBe(1920);
      expect(rows.rows[0]!.height).toBe(1080);
      expect(Number(rows.rows[0]!.verified_bytes)).toBe(1024);
      expect(rows.rows[0]!.verified_type).toBe("image/png");
    });

    it("is idempotent for a repeat of the SAME verdict, and says it changed nothing", async () => {
      // `applied: false` IS THE WHOLE VALUE OF THE FIELD. A worker that timed out and
      // retried gets a 200 either way; what it learns from this field is whether its
      // own call is the one that moved the row.
      const id = await slot(keyA);
      expect(await (await verdict(id, ready, WORKER)).json()).toEqual({
        applied: true,
        state: "ready",
      });
      const again = await verdict(id, ready, WORKER);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ applied: false, state: "ready" });
    });

    it("REFUSES a verdict for a rejected object with 422, because its bytes are gone", async () => {
      // The refusal is the half worth testing. A 200 here would let a stale worker move
      // a state whose object no longer exists, and the row would then promise a client
      // something the store cannot serve.
      const id = await slot(keyA);
      await verdict(
        id,
        { verdict: "rejected", reason: "scan_failed" },
        WORKER,
      );
      const res = await verdict(id, ready, WORKER);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe(
        "unprocessable_request",
      );
      expect(await stateOf(id)).toBe("rejected");
    });

    it("answers 404 for an id no object has", async () => {
      expect((await verdict(randomUUID(), ready, WORKER)).status).toBe(404);
    });

    it("answers 400 for a malformed id rather than 500", async () => {
      // `gaps.md` 058-3 measured sixteen shipped routes answering 500 to `not-a-uuid`.
      // This route is new, so getting it right costs one pipe.
      const res = await fetch(`${url}/internal/media/not-a-uuid/verdict`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${WORKER}`,
        },
        body: JSON.stringify(ready),
      });
      expect(res.status).toBe(400);
    });

    it("refuses a `retry` verdict, which the contract deliberately has no arm for", async () => {
      const id = await slot(keyA);
      const res = await verdict(id, { verdict: "retry" }, WORKER);
      expect(res.status).toBe(400);
      expect(await stateOf(id)).toBe("pending");
    });
  });

  // ── THE REJECTION PATH (T015) ───────────────────────────────────────────────────

  describe("a rejection", () => {
    it("deletes the bytes AND keeps the row (FR-MED-04)", async () => {
      const id = await slot(keyA);
      const key = await objectKeyOf(id);
      await upload(key, "X".repeat(64));
      expect(await storeHas(key), "the fixture's own bytes are not there").toBe(
        true,
      );

      const res = await verdict(
        id,
        { verdict: "rejected", reason: "declaration_mismatch" },
        WORKER,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ applied: true, state: "rejected" });

      // BOTH HALVES. A state change that leaves the bytes in the store is the failure
      // FR-MED-03 exists to prevent; a delete that removes the row destroys the audit
      // record FR-MED-04 says to keep.
      expect(await storeHas(key)).toBe(false);
      expect(await stateOf(id)).toBe("rejected");

      const rows = await pool.query<{ rejected_reason: string; declared_bytes: string }>(
        "select rejected_reason, declared_bytes from media_objects where id = $1",
        [id],
      );
      expect(rows.rows[0]!.rejected_reason).toBe("declaration_mismatch");
      // THE DECLARATION SURVIVES, which is the reason T016 excludes the row rather than
      // zeroing the column: `declared_bytes` is what the client claimed, and that claim
      // is the audit record's substance.
      expect(Number(rows.rows[0]!.declared_bytes)).toBe(1024);
    });

    it("stops the bytes counting against the storage quota (T016)", async () => {
      // A SUM OVER ROWS, NOT A COUNTER, so a delete needs no subtraction — SRS 1.17
      // chose that shape for this moment. The observable is that the same tenant can
      // reserve the space again.
      const rows = await pool.query<{ committed: string }>(
        "select coalesce(sum(declared_bytes), 0) as committed from media_objects where environment_id = $1 and state <> 'rejected'",
        [envA.id],
      );
      const before = Number(rows.rows[0]!.committed);

      const id = await slot(keyA, 8192);
      await verdict(
        id,
        { verdict: "rejected", reason: "scan_failed" },
        WORKER,
      );

      const after = await pool.query<{ committed: string }>(
        "select coalesce(sum(declared_bytes), 0) as committed from media_objects where environment_id = $1 and state <> 'rejected'",
        [envA.id],
      );
      expect(Number(after.rows[0]!.committed)).toBe(before);
    });
  });
});
