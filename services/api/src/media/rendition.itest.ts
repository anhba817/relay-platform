import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintUserToken } from "../auth/user-token";
import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  recordMediaVerdict,
  Repository,
  unreferencedMediaIn,
} from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// A DERIVED OBJECT BELONGS TO ITS PARENT (FR-MED-05, US1).
//
// **NO DECODER APPEARS IN THIS FILE, WHICH IS THE POINT OF THE STORY.** FR-MED-05 has two
// halves that fail for different reasons: generating bytes is a question about what this
// platform may depend on, and *"sharing the parent's lifecycle"* is a question about rows
// and predicates. The second is answerable today, with renditions planted by hand, and it
// is the half two shipped clauses would otherwise destroy — FR-MED-08 refuses an object no
// message references, and FR-MED-10 reaps one.
//
// ITS OWN FILE for `attach.itest.ts`'s reason: a new file costs the fence chain nothing
// until somebody publishes it, and this suite needs two tenants, two users and a planted
// row shape that no other media suite wants.
describe("a rendition belongs to its parent", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let otherEnv: { id: string };
  let key: { credential: string };
  let otherKey: { credential: string };
  let channelId: string;
  let privateChannelId: string;
  let memberToken: string;
  let outsiderToken: string;
  const store = storeConfig();

  /** A `ready` parent, planted directly. The slot route would do, but this suite is about
   * what happens to rows and a slot costs a signed round trip to the store per object. */
  const plantParent = async (opts: { bytes?: number } = {}): Promise<string> => {
    const { rows } = (await db.execute(sql`
      INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes,
                                 state, object_key, width, height)
      VALUES (gen_random_uuid(), ${env.id}, 'p.png', 'image/png', ${opts.bytes ?? 4096},
              'ready', ${env.id} || '/' || gen_random_uuid(), 1200, 900)
      RETURNING id`)) as unknown as { rows: { id: string }[] };
    return rows[0]!.id;
  };

  /** A thumbnail of that parent. `state` is `ready` because
   * `media_objects_rendition_state_check` permits nothing else. */
  const plantRendition = async (parentId: string): Promise<string> => {
    const { rows } = (await db.execute(sql`
      INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes,
                                 state, object_key, parent_id, rendition, width, height)
      VALUES (gen_random_uuid(), ${env.id}, 'p-thumbnail.webp', 'image/webp', 7104,
              'ready', ${env.id} || '/' || gen_random_uuid(), ${parentId}, 'thumbnail',
              320, 240)
      RETURNING id`)) as unknown as { rows: { id: string }[] };
    return rows[0]!.id;
  };

  const backdate = (id: string, interval: string) =>
    db.execute(
      sql`UPDATE media_objects SET created_at = now() - ${sql.raw(`interval '${interval}'`)} WHERE id = ${id}`,
    );

  const attach = (mediaId: string, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: "rendition-bot",
        text: "a photo",
        attachments: [{ type: "media", media_id: mediaId }],
      }),
    });

  const fetchMedia = (mediaId: string, credential: string) =>
    fetch(`${url}/v1/media/${mediaId}`, {
      headers: { authorization: `Bearer ${credential}` },
      redirect: "manual",
    });

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());

    env = await createEnvironment(db, { name: "rendition-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    otherEnv = await createEnvironment(db, { name: "rendition-itest-other" });
    otherKey = await createApiKey(db, { environmentId: otherEnv.id });

    const repo = new Repository(db, env.id);
    const member = await repo.createUser("rendition-member");
    await repo.createUser("rendition-outsider");
    await repo.upsertUser("rendition-bot", {
      display_name: "Rendition Bot",
      kind: "bot",
      description: "attaches media in an integration test",
    });
    const channel = await repo.createChannel("renditions", "public");
    channelId = channel.id;
    await repo.addMember(channel.id, member.id);
    // A PRIVATE CHANNEL IS WHAT MAKES THE REFUSAL TESTABLE. `channelVisibleTo` checks
    // membership for `private` channels ONLY (SRS 1.19), so a public channel is readable
    // by every user of the environment and an "unauthorised" caller cannot exist in one.
    const priv = await repo.createChannel("renditions-private", "private");
    privateChannelId = priv.id;
    await repo.addMember(priv.id, member.id);

    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    memberToken = (
      await mintUserToken(secret, {
        user: "rendition-member",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;
    outsiderToken = (
      await mintUserToken(secret, {
        user: "rendition-outsider",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
      { logger: false },
    );
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── THE REAPER'S PREDICATE (SC-001) ─────────────────────────────────────────────────

  describe("what FR-MED-10 would collect", () => {
    it("leaves a referenced parent and its rendition alone, either side of the boundary", async () => {
      const parent = await plantParent();
      await plantRendition(parent);
      expect((await attach(parent)).status).toBe(201);
      await backdate(parent, "48 hours");

      // ONE INSTANT, PINNED BEFORE THE QUERY RUNS. `now()` evaluated inside the
      // assertion is a different moment from the one the fixture used, which is the
      // defect 043's `reset-lane` test had and 4.13's `pinWindow` was written for.
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const collected = await unreferencedMediaIn(db, env.id, cutoff, 500);

      expect(collected, "a referenced parent is not unreferenced").not.toContain(parent);
    });

    it("collects an unreferenced parent, and never its rendition — the cascade owns that", async () => {
      const parent = await plantParent();
      const rendition = await plantRendition(parent);
      await backdate(parent, "48 hours");
      await backdate(rendition, "48 hours");

      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const collected = await unreferencedMediaIn(db, env.id, cutoff, 500);

      expect(collected, "an unreferenced parent is collectable").toContain(parent);
      // FR-002. NOT "the rendition is also collected" — the predicate must never name it
      // at all, because `media_objects_parent_fk` is ON DELETE CASCADE and a reaper that
      // deleted both separately would depend on the order it did them in.
      expect(collected, "a rendition is never returned on its own").not.toContain(rendition);
    });

    it("does not collect a parent younger than the boundary", async () => {
      const parent = await plantParent();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(await unreferencedMediaIn(db, env.id, cutoff, 500)).not.toContain(parent);
    });

    it("does not collect another tenant's unreferenced object", async () => {
      const parent = await plantParent();
      await backdate(parent, "48 hours");
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // Constitution I. The predicate takes its scope as an argument, so this is the
      // arm that proves the argument is used rather than accepted and ignored.
      expect(await unreferencedMediaIn(db, otherEnv.id, cutoff, 500)).not.toContain(parent);
    });
  });

  // ── DELETION (SC-002) ───────────────────────────────────────────────────────────────

  describe("deleting a parent", () => {
    it("takes its rendition with it", async () => {
      const parent = await plantParent();
      const rendition = await plantRendition(parent);

      const before = (await db.execute(
        sql`SELECT count(*)::text AS n FROM media_objects WHERE id = ${parent} OR parent_id = ${parent}`,
      )) as unknown as { rows: { n: string }[] };
      expect(before.rows[0]!.n).toBe("2");

      await db.execute(sql`DELETE FROM media_objects WHERE id = ${parent}`);

      const after = (await db.execute(
        sql`SELECT count(*)::text AS n FROM media_objects WHERE id = ${rendition}`,
      )) as unknown as { rows: { n: string }[] };
      expect(after.rows[0]!.n, "the cascade did not fire").toBe("0");
    });

    it("has no production caller, and the count is the assertion", async () => {
      // SC-002, AND THE CRITERION NEEDED A FLOOR BEFORE IT MEANT ANYTHING.
      //
      // "A test for every path that deletes a media object" passes by enumerating
      // nothing when there are no such paths — which is the shape CLAUDE.md calls a test
      // that proves nothing. **Nothing in this platform deletes a `media_objects` row.**
      // The rejection path deletes BYTES and keeps the row on purpose (`0018`: "a
      // rejected object's row is all that survives it"), because a refusal has to stay
      // auditable after the object is gone.
      //
      // So this asserts the NUMBER. The day the erasure chapter writes the first row
      // deletion this goes red, and whoever is holding it reads the paragraph above and
      // wires `deleteObjectWithRenditions` into the path they just built.
      const { execSync } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");

      // THE ROOT IS FOUND, NOT ASSUMED. The first version searched `src` relative to
      // `process.cwd()`, which is `services/api` under the integration config and the
      // REPOSITORY ROOT under `vitest.coverage.config.mts` — so the same test looked at
      // two different places and found nothing in one of them. **The positive control
      // below is what caught it**, by refusing rather than passing on an empty sweep.
      let root = process.cwd();
      while (!existsSync(join(root, "pnpm-workspace.yaml")) && dirname(root) !== root) {
        root = dirname(root);
      }
      const target = join(root, "services", "api", "src");

      const sweep = (pattern: string): string[] =>
        execSync(
          `grep -rn '${pattern}' --include='*.ts' ${target} | grep -v '\\.test\\.\\|\\.itest\\.' || true`,
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);

      // THE POSITIVE CONTROL FIRST, BECAUSE THE ASSERTION BELOW IS `toHaveLength(0)`.
      // A wrong path, a renamed directory or a `grep` that cannot parse its own pattern
      // all produce zero hits and a green test — "an instrument that reports zero has to
      // prove it looked" is the rule, and this is the shape it was written about. Reads
      // of the table must come back before an absence of deletes means anything.
      expect(
        sweep("from(mediaObjects)").length,
        "the sweep found no reads of media_objects at all, so it did not look",
      ).toBeGreaterThan(0);

      const hits = sweep("delete(mediaObjects)\\|DELETE FROM media_objects");
      expect(
        hits,
        `row-deletion paths changed:\n${hits.join("\n")}\nWire deleteObjectWithRenditions into the new one.`,
      ).toHaveLength(0);
    });
  });

  // ── AUTHORISATION (SC-003) ──────────────────────────────────────────────────────────

  describe("who may read a rendition", () => {
    it("serves it to a caller who may read the parent's channel", async () => {
      const parent = await plantParent();
      const rendition = await plantRendition(parent);
      expect((await attach(parent, privateChannelId)).status).toBe(201);

      // THE POSITIVE CONTROL, and without it the two refusals below would pass against a
      // gate that refuses everybody.
      const res = await fetchMedia(rendition, memberToken);
      expect(res.status, "a member could not read the rendition of a message they can read").toBe(
        200,
      );
      // The route hands back a signed URL in a body rather than redirecting, so the
      // status alone would also pass on an empty 200.
      const body = (await res.json()) as { url?: string };
      expect(body.url, "a 200 with no URL is not delivery").toContain("X-Amz-Signature=");
    });

    it("refuses a caller who may not, identically to an id no object has", async () => {
      const parent = await plantParent();
      const rendition = await plantRendition(parent);
      expect((await attach(parent, privateChannelId)).status).toBe(201);

      const refused = await fetchMedia(rendition, outsiderToken);
      const absent = await fetchMedia(crypto.randomUUID(), outsiderToken);

      expect(refused.status).toBe(absent.status);
      const a = (await refused.json()) as Record<string, unknown>;
      const b = (await absent.json()) as Record<string, unknown>;
      // FR-MED-08's indistinguishability rule, tested the way 4.11 and 4.12 tested it:
      // the bodies differ only in `request_id`. A refusal that named the cause would
      // report whether somebody else's rendition exists.
      delete a["request_id"];
      delete b["request_id"];
      expect(a).toEqual(b);
    });

    it("refuses a rendition whose parent is referenced by nothing", async () => {
      const parent = await plantParent();
      const rendition = await plantRendition(parent);
      // No message names the parent, so nobody may read the parent — and therefore
      // nobody may read the rendition. FR-MED-08 in both directions.
      expect((await fetchMedia(parent, memberToken)).status).toBe(404);
      expect((await fetchMedia(rendition, memberToken)).status).toBe(404);
    });
  });

  // ── THE VERDICT AND THE RENDITION ARE ONE FACT (T037b) ──────────────────────────────

  describe("the transaction recordMediaVerdict did not have", () => {
    /** A `pending` parent, since the compare-and-set needs one. */
    const plantPending = async (): Promise<string> => {
      const { rows } = (await db.execute(sql`
        INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes,
                                   state, object_key)
        VALUES (gen_random_uuid(), ${env.id}, 'q.png', 'image/png', 4096,
                'pending', ${env.id} || '/' || gen_random_uuid())
        RETURNING id`)) as unknown as { rows: { id: string }[] };
      return rows[0]!.id;
    };

    it("leaves the parent pending when the rendition insert fails", async () => {
      const parent = await plantPending();
      const taken = await plantParent();

      // FORCE THE INSERT TO FAIL by reusing an id that already exists. The verdict's
      // UPDATE lands first inside the transaction, so without one the parent would be
      // `ready` with no rendition and no reason — the absence FR-007 forbids.
      await expect(
        recordMediaVerdict(db, {
          id: parent,
          verdict: "ready",
          verifiedBytes: 4096,
          verifiedType: "image/png",
          rendition: {
            id: taken,
            kind: "thumbnail",
            objectKey: `${env.id}/dup`,
            bytes: 7104,
            width: 320,
            height: 240,
          },
        }),
      ).rejects.toThrow();

      const { rows } = (await db.execute(
        sql`SELECT state FROM media_objects WHERE id = ${parent}`,
      )) as unknown as { rows: { state: string }[] };
      // RUN RED AGAINST THE UNTRANSACTED VERSION FIRST — it reported `ready` here, which
      // is the whole reason this test exists. A test that passes because nothing made it
      // fail is the shape this project keeps paying for.
      expect(rows[0]!.state, "the verdict committed without its rendition").toBe("pending");
    });

    it("writes both when the rendition is good", async () => {
      const parent = await plantPending();
      const renditionId = crypto.randomUUID();
      const result = await recordMediaVerdict(db, {
        id: parent,
        verdict: "ready",
        verifiedBytes: 4096,
        verifiedType: "image/png",
        rendition: {
          id: renditionId,
          kind: "thumbnail",
          objectKey: `${env.id}/${renditionId}`,
          bytes: 7104,
          width: 320,
          height: 240,
        },
      });
      expect(result.applied).toBe(true);

      const { rows } = (await db.execute(sql`
        SELECT state, parent_id, rendition, declared_bytes, user_id
        FROM media_objects WHERE id = ${renditionId}`)) as unknown as {
        rows: { state: string; parent_id: string; rendition: string; declared_bytes: string }[];
      };
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parent_id).toBe(parent);
      expect(rows[0]!.rendition).toBe("thumbnail");
      expect(rows[0]!.state).toBe("ready");
      // FR-012: the quota sums `declared_bytes` over every non-rejected row, so a
      // rendition's actual length has to land in the column whose comment says it holds
      // what the caller declared. Nobody declared this one.
      expect(Number(rows[0]!.declared_bytes)).toBe(7104);
    });

    it("records a reason on the parent when no rendition was made", async () => {
      const parent = await plantPending();
      await recordMediaVerdict(db, {
        id: parent,
        verdict: "ready",
        verifiedBytes: 4096,
        verifiedType: "image/png",
        renditionFailedReason: "decode_failed",
      });
      const { rows } = (await db.execute(sql`
        SELECT state, rendition_failed_reason FROM media_objects WHERE id = ${parent}`)) as unknown as {
        rows: { state: string; rendition_failed_reason: string }[];
      };
      // FR-008: a failed rendition never stops the parent reaching `ready`, because the
      // sweep re-reads `pending` rows for ever and an object stuck there is an infinite
      // retry wearing a state's clothes.
      expect(rows[0]!.state).toBe("ready");
      // FR-007: a value, not an absence.
      expect(rows[0]!.rendition_failed_reason).toBe("decode_failed");
    });

    it("writes one rendition when the verdict is delivered twice", async () => {
      const parent = await plantPending();
      const mk = (id: string) => ({
        id: parent,
        verdict: "ready" as const,
        verifiedBytes: 4096,
        verifiedType: "image/png",
        rendition: {
          id,
          kind: "thumbnail",
          objectKey: `${env.id}/${id}`,
          bytes: 7104,
          width: 320,
          height: 240,
        },
      });
      const first = await recordMediaVerdict(db, mk(crypto.randomUUID()));
      const second = await recordMediaVerdict(db, mk(crypto.randomUUID()));

      expect(first.applied).toBe(true);
      // FR-010. The compare-and-set is what stops the second: the row is no longer
      // `pending`, so the UPDATE matches nothing and the INSERT below it never runs.
      // Asserted by issuing the duplicate rather than by reasoning that it cannot happen
      // — which is what 4.14's five accounting tests were each protecting against.
      expect(second.applied).toBe(false);
      const { rows } = (await db.execute(
        sql`SELECT count(*)::text AS n FROM media_objects WHERE parent_id = ${parent}`,
      )) as unknown as { rows: { n: string }[] };
      expect(rows[0]!.n, "a duplicate verdict wrote a second rendition").toBe("1");
    });
  });

  // ── ATTACHMENT (FR-004) ─────────────────────────────────────────────────────────────

  it("refuses to let a message attach a rendition", async () => {
    const parent = await plantParent();
    const rendition = await plantRendition(parent);

    const res = await attach(rendition);
    expect(res.status, "a rendition is ready and of this tenant, so it would have passed").toBe(
      422,
    );
    // `media_not_attachable`, and the name matters for this test's whole point:
    // `messages.service.ts:141` is the ONLY site that throws it, so a rendition, another
    // tenant's object and an id nobody has all arrive at the same refusal. (An earlier
    // draft asserted `media_not_available`, which chapter 4.11 deleted.)
    expect(((await res.json()) as { code: string }).code).toBe("media_not_attachable");
  });
});
