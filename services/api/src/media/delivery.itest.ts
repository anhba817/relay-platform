import "reflect-metadata";

import { crc32, deflateSync } from "node:zlib";

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
  Repository,
} from "../db/repository";
import { presign } from "./presign";
import { ensureBucket, storeConfig } from "./store";

// THE DELIVERY URL, END TO END (FR-MED-08).
//
// ITS OWN FILE, and a new file costs the fence chain nothing — the cheap direction 051
// recorded and 4.11 used.
//
// THE HALF THIS CHAPTER DID NOT BUILD IS CITED RATHER THAN RE-PROVEN. FR-MED-08's
// *"object storage shall not be publicly readable"* is `presign.itest.ts:53`, whose own
// title names this clause: signed GET 200, unsigned 403, tampered 403, measured from
// outside the container two chapters ago. What is new here is the other half — *"issued
// only to callers authorised to read the referencing message"* — and the two probes below
// that re-ask the store's questions about a GET of an object THIS route signed do so
// because a platform could hold one verb and not the other.
describe("delivering hosted media", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let otherEnv: { id: string };
  let key: { credential: string };
  let otherKey: { credential: string };
  /** `public`, `private` with one member, and a second private nobody in this suite joins. */
  let publicChannel: string;
  let privateChannel: string;
  let otherPrivateChannel: string;
  /** Two users of ONE tenant: `alice` is in the private channel, `mallory` is not. */
  let alice: string;
  let mallory: string;
  /** A token for an external id no user row has — minting does not require one. */
  let ghost: string;
  const store = storeConfig();

  /** A REAL PNG, BUILT HERE, AND THE VERIFICATION CHAPTER IS WHY.
   *
   * This fixture declared `bytes: 1024` and uploaded `` `bytes ${randomUUID()}` `` —
   * **42 bytes of ASCII** — and it was correct when it was written: 4.10's slot route
   * records *"what the caller said, not what arrived"*, so nothing could disagree with
   * it. **The fixtures did not rot; the platform grew a check.** Under FR-MED-03 every
   * object this suite creates would now be rejected twice over, on size and on type.
   *
   * Unique per call, because one test asserts that the delivered URL serves the bytes
   * that were uploaded, and two identical files would let a mixed-up id pass. */
  let pngCounter = 0;
  const uniquePng = (): Uint8Array => {
    const height = 8 + (pngCounter += 1);
    const width = 16;
    const raw = Buffer.alloc(height * (1 + width));
    for (let y = 0; y < height; y += 1) raw[y * (1 + width)] = 0;
    const u32 = (n: number) =>
      Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const chunk = (type: string, body: Buffer) => {
      const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
      return Buffer.concat([u32(body.length), typed, u32(crc32(typed) >>> 0)]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 0, 0, 0, 0])])),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };

  const slot = async (credential: string, bytes: number) => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "p.png", mime_type: "image/png", bytes }),
    });
    expect(res.status, "the slot route did not issue an id to test with").toBe(201);
    return (await res.json()) as { media_id: string; upload_url: string };
  };

  /** AN APPLICATION CREDENTIAL HAS TO NAME ITS SENDER AND A USER TOKEN MAY NOT.
   *
   * The first version of this fixture sent `{ text, attachments }` for both and every
   * key-credential send answered 400 — the same defect 4.11's quickstart hit, where a
   * reader following it would have concluded the platform was broken. The token carries
   * the identity; the key does not, so it names a bot (FR-007 refuses a person). */
  const send = async (channel: string, mediaId: string, credential: string) => {
    const asKey = credential.startsWith("rk_");
    const res = await fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: `carrying ${mediaId}`,
        attachments: [{ type: "media", media_id: mediaId }],
        ...(asKey ? { user: "delivery-bot" } : {}),
      }),
    });
    expect(res.status, "the fixture's send was refused").toBe(201);
    return (await res.json()) as { id: string };
  };

  const get = (mediaId: string, credential: string) =>
    fetch(`${url}/v1/media/${mediaId}`, {
      headers: { authorization: `Bearer ${credential}` },
    });

  /** A referenced, readable object in one call: slot, upload real bytes, mark it
   * verified, send.
   *
   * THE STATE IS WRITTEN DIRECTLY AND THAT IS A DECISION (T048). ADR-14's gate means a
   * delivery needs an object in `ready`, and the only thing that produces one is the
   * media worker — so this suite could have spawned it, or polled for it, and either
   * would make **a delivery test fail when the scanner is down**. That test would then
   * be reporting somebody else's outage under a name about authorisation.
   *
   * The end-to-end path — upload, sweep, verdict, `ready` — is covered where it belongs:
   * `services/media-worker/src/verify.itest.ts` runs it against a real store and a real
   * scanner, and the sealed suite runs it against the composed stack. **This file is
   * about who may hold a URL**, and its fixture states the precondition rather than
   * producing it.
   *
   * THE BYTES ARE A REAL PNG AT ITS REAL LENGTH ANYWAY. Writing the state directly means
   * nothing checks them here, and an honest fixture costs ten lines — a fixture that
   * lies about what it uploaded is the thing this chapter is about. */
  const attached = async (
    channel: string,
    credential: string,
    bytes: Uint8Array = uniquePng(),
  ): Promise<{ mediaId: string; bytes: Uint8Array; messageId: string }> => {
    const issued = await slot(credential, bytes.length);
    const put = await fetch(issued.upload_url, {
      method: "PUT",
      body: bytes.slice() as unknown as BodyInit,
    });
    expect(put.status, "the fixture could not upload its own bytes").toBe(200);
    await markReady(issued.media_id, bytes.length);
    const message = await send(channel, issued.media_id, credential);
    return { mediaId: issued.media_id, bytes, messageId: message.id };
  };

  /** What the worker would have written, written by the fixture. */
  const markReady = async (mediaId: string, bytes: number): Promise<void> => {
    await db.execute(
      `UPDATE media_objects SET state = 'ready', verified_bytes = ${bytes}, ` +
        `verified_type = 'image/png' WHERE id = '${mediaId}'`,
    );
  };

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());

    env = await createEnvironment(db, { name: "delivery-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    otherEnv = await createEnvironment(db, { name: "delivery-itest-other" });
    otherKey = await createApiKey(db, { environmentId: otherEnv.id });

    const repo = new Repository(db, env.id);
    const a = await repo.createUser("delivery-alice");
    await repo.createUser("delivery-mallory");
    // AN API KEY MAY SEND ONLY AS A BOT (FR-007), and a bot needs a description —
    // `users_bot_description_check`. 4.11 paid for both of those in a fixture.
    await repo.upsertUser("delivery-bot", {
      display_name: "Delivery Bot",
      kind: "bot",
      description: "delivers media in an integration test",
    });

    publicChannel = (await repo.createChannel("delivery-public", "public")).id;
    const priv = await repo.createChannel("delivery-private", "private");
    privateChannel = priv.id;
    otherPrivateChannel = (await repo.createChannel("delivery-private-2", "private")).id;
    // `addMember` TAKES THE ROW'S UUID, NOT THE EXTERNAL ID.
    await repo.addMember(priv.id, a.id);

    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    alice = (
      await mintUserToken(secret, {
        user: "delivery-alice",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;
    mallory = (
      await mintUserToken(secret, {
        user: "delivery-mallory",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;
    ghost = (
      await mintUserToken(secret, {
        user: "delivery-ghost",
        environmentId: env.id,
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
  });

  // ── US1 · THE GRANT ─────────────────────────────────────────────────────────────────

  it("hands a member a URL whose bytes are the ones uploaded (SC-001)", async () => {
    const { mediaId, bytes } = await attached(privateChannel, alice);

    const res = await get(mediaId, alice);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_at: string };

    // TWO FIELDS AND NOTHING ELSE (FR-013's shape, one route over). A `state` here would
    // be the platform telling a client about an object it has not verified.
    expect(Object.keys(body).sort()).toEqual(["expires_at", "url"]);

    // BYTE-IDENTICAL, WHICH IS THE WHOLE CLAIM. A 200 from the store proves the signature;
    // only the body proves the URL names the object the caller asked for.
    const fetched = await fetch(body.url);
    expect(fetched.status).toBe(200);
    // BYTES, NOT TEXT. The fixture now uploads a real PNG, and `text()` on binary decodes
    // as UTF-8 — every byte above 0x7f becomes U+FFFD, so two different images compare
    // equal and the assertion stops being about identity at all.
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it("signs for one hour, and with the endpoint a CLIENT can reach (FR-026)", async () => {
    const { mediaId } = await attached(privateChannel, alice);
    const { url: signed } = (await (await get(mediaId, alice)).json()) as { url: string };

    expect(new URL(signed).searchParams.get("X-Amz-Expires")).toBe("3600");
    // `endpoint`, NOT `internalEndpoint`. The host is inside the SigV4 signature, so this
    // is not a cosmetic difference: a URL signed with the api's own address is refused by
    // the store rather than merely awkward to reach.
    expect(signed.startsWith(store.endpoint)).toBe(true);
    expect(new URL(signed).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("hands an APPLICATION credential a URL whatever the memberships are (FR-006)", async () => {
    // Sent by the key into a PRIVATE channel the key is not a member of — an application
    // credential has no user and no membership, which is the clause's *"or API key"* arm.
    const { mediaId } = await attached(otherPrivateChannel, key.credential);
    expect((await get(mediaId, key.credential)).status).toBe(200);
  });

  it("hands a PRIVATE channel's member a URL — the only test that reaches isMember", async () => {
    // WITHOUT THIS THE WHOLE MEMBERSHIP PATH CAN BE BROKEN AND EVERY OTHER TEST PASSES.
    // The public-channel test returns true before `isMember` is consulted, and the
    // private-non-member test expects a refusal, which a broken predicate also produces.
    // The grant exercises membership; the refusal does not.
    const { mediaId } = await attached(privateChannel, key.credential);
    expect((await get(mediaId, alice)).status).toBe(200);
  });

  it("hands a PUBLIC channel's non-member a URL — membership is not the rule", async () => {
    // THE CASE A LITERAL READING OF FR-MED-08 WOULD HAVE REFUSED. `mallory` is in no
    // channel at all and can read this message's text, so refusing the photo in it would
    // make media stricter than the message carrying it. 11,557 public channels on this
    // lane against 1,016 private: the common case, not the edge.
    const { mediaId } = await attached(publicChannel, key.credential);
    expect((await get(mediaId, mallory)).status).toBe(200);
  });

  // ── US1 · WHAT THE STORE ENFORCES, ASKED AGAIN FOR A GET ─────────────────────────────

  it("refuses a delivery URL whose expiry has passed, from the store's own clock", async () => {
    const { mediaId } = await attached(privateChannel, alice);
    const { url: signed } = (await (await get(mediaId, alice)).json()) as { url: string };
    const key_ = new URL(signed).pathname.replace(`/${store.bucket}/`, "");

    // ASSERTING THAT OUR OWN ARITHMETIC PRODUCED AN EARLIER TIMESTAMP PROVES NOTHING
    // ABOUT THE STORE, so the expired URL is signed and sent.
    const expired = presign({
      method: "GET",
      ...store,
      key: key_,
      expiresIn: 1,
      now: new Date(Date.now() - 60_000),
    });
    const res = await fetch(expired);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Request has expired");
  });

  it("refuses a delivery URL with one character of the signature changed", async () => {
    const { mediaId } = await attached(privateChannel, alice);
    const { url: signed } = (await (await get(mediaId, alice)).json()) as { url: string };

    // THE MUTATION IS CHECKED. 4.10's first tamper probe replaced the signature's first
    // character with `f` and was a no-op on 255 of 4,096 signings, reading the store's
    // honest 200 as an acceptance. Mapping the character to a different one is what makes
    // the probe's own claim true, and the assertion is what says it out loud.
    const tampered = signed.replace(
      /X-Amz-Signature=(.)/,
      (_m, c: string) => `X-Amz-Signature=${c === "f" ? "0" : "f"}`,
    );
    expect(tampered, "the tamper was a no-op").not.toBe(signed);

    const res = await fetch(tampered);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("SignatureDoesNotMatch");
  });

  // ── US2 · ONE REFUSAL, FOUR CONDITIONS ──────────────────────────────────────────────

  it("refuses an object of another environment", async () => {
    const { mediaId } = await attached(publicChannel, key.credential);
    expect((await get(mediaId, otherKey.credential)).status).toBe(404);
  });

  it("refuses an object referenced only in a private channel the caller is not in", async () => {
    const { mediaId } = await attached(privateChannel, key.credential);
    expect((await get(mediaId, mallory)).status).toBe(404);
  });

  it("refuses a media_id no object has", async () => {
    expect((await get(randomUUID(), key.credential)).status).toBe(404);
  });

  it("refuses an object with NO referencing message, to the credential that uploaded it", async () => {
    // THE CASE THE SPECIFICATION ASSUMED THE OTHER WAY. Granting the uploader access is a
    // second authorisation rule that does not follow a message — the parallel ACL
    // FR-MED-08's own note forbids — and FR-MED-10 hard-deletes unreferenced objects after
    // 24 hours, so it would be a read path to a thing already scheduled for destruction.
    const orphanBytes = uniquePng();
    const issued = await slot(key.credential, orphanBytes.length);
    await fetch(issued.upload_url, {
      method: "PUT",
      body: orphanBytes.slice() as unknown as BodyInit,
    });
    // READY, so the refusal below is about the missing reference and not about the
    // gate — two reasons for one 404 would make this test unable to say which fired.
    await markReady(issued.media_id, orphanBytes.length);
    expect((await get(issued.media_id, key.credential)).status).toBe(404);
  });

  it("gives all SIX refusals ONE body, compared whole (FR-012)", async () => {
    // THE CODE IS NOT THE ORACLE. A message or an extra field leaks existence exactly as
    // well as a code does, so the comparison is over the whole body with `request_id`
    // removed — the only field that is allowed to differ.
    //
    // TWO NEW CONDITIONS ARRIVE WITH ADR-14's GATE, and they are the two that would have
    // been easiest to get wrong. An object still under verification and an object the
    // scanner refused are both facts about a caller's own upload, so a helpful platform
    // would report them — and reporting them here would tell an attacker holding a
    // guessed id that the object exists, which is exactly what the other four refusals
    // were built to withhold. FR-MED-09's rejection marker reaches a client through the
    // message payload, in a later chapter, where the caller has already proved they can
    // read the message.
    const foreign = await attached(publicChannel, key.credential);
    const unreadable = await attached(privateChannel, key.credential);
    const orphan = await slot(key.credential, uniquePng().length);

    // Referenced and readable, and NOT `ready`: the gate is the only thing refusing it.
    const stillPending = await attached(publicChannel, key.credential);
    await db.execute(
      `UPDATE media_objects SET state = 'pending' WHERE id = '${stillPending.mediaId}'`,
    );
    const refused = await attached(publicChannel, key.credential);
    await db.execute(
      `UPDATE media_objects SET state = 'rejected', rejected_reason = 'scan_failed' ` +
        `WHERE id = '${refused.mediaId}'`,
    );

    const bodies = await Promise.all(
      [
        get(foreign.mediaId, otherKey.credential),
        get(unreadable.mediaId, mallory),
        get(randomUUID(), key.credential),
        get(orphan.media_id, key.credential),
        get(stillPending.mediaId, key.credential),
        get(refused.mediaId, key.credential),
      ].map(async (p) => {
        const res = await p;
        expect(res.status).toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        delete body["request_id"];
        return body;
      }),
    );

    for (let i = 1; i < bodies.length; i += 1) expect(bodies[i]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: "not_found" });
  });

  it("and the CONTROL: the same objects deliver once they are ready", async () => {
    // Without this the test above passes against a route that refuses everything, which
    // is the shape 4.9 found in the gauntlet and 4.12 found in its own scope probes.
    const pendingThenReady = await attached(publicChannel, key.credential);
    await db.execute(
      `UPDATE media_objects SET state = 'pending' WHERE id = '${pendingThenReady.mediaId}'`,
    );
    expect((await get(pendingThenReady.mediaId, key.credential)).status).toBe(404);

    await markReady(pendingThenReady.mediaId, pendingThenReady.bytes.length);
    expect((await get(pendingThenReady.mediaId, key.credential)).status).toBe(200);
  });

  it("stops delivering once the referencing message is deleted (4.11's FR-024)", async () => {
    // ASSERTED RATHER THAN ASSUMED: nothing else in the platform connects "a delete nulls
    // `attachments`" to "the object stops being readable". Two chapters, one consequence.
    const { mediaId, messageId } = await attached(publicChannel, key.credential);
    expect((await get(mediaId, key.credential)).status).toBe(200);

    const deleted = await fetch(`${url}/v1/channels/${publicChannel}/messages/${messageId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key.credential}` },
    });
    expect(deleted.status, "the fixture's delete was refused").toBe(204);

    expect((await get(mediaId, key.credential)).status).toBe(404);
  });

  it("refuses a token naming a user this tenant does not have", async () => {
    // THE ARM THE ROUTE NEEDED AND THE SUITE WOULD NOT HAVE REACHED. `deliver` resolves
    // the external id before the predicate sees it, and a token can outlive the user it
    // names. Without this the resolution's failure arm is dead code with a pin over it.
    // 400 and not 404: this is the same answer `messages.controller.ts` gives, and the
    // caller's credential is the thing that is wrong rather than the object.
    const { mediaId } = await attached(publicChannel, key.credential);
    const res = await get(mediaId, ghost);
    expect(res.status).toBe(400);
  });

  it("refuses a malformed media_id with 400, naming the parameter", async () => {
    // THE FIRST ROUTE IN THIS API THAT VALIDATES A PATH PARAMETER. The other sixteen
    // answer 500 `internal_error` — measured in `gaps.md` with its control.
    const res = await get("not-a-uuid", key.credential);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request", field: "mediaId" });
  });

  // ── US3 · ONE OBJECT, TWO CHANNELS, TWO ANSWERS ─────────────────────────────────────

  it("authorises through ANY referencing channel, not the first one found", async () => {
    // FR-MSG-11 has allowed the same id twice since 3.24, and forwarding a photo into a
    // second channel is the ordinary way one object acquires a second reference. So
    // authorisation is a disjunction, and a lookup that stopped at one row would refuse a
    // caller whose channel happened to be second — a correctness bug that presents as
    // flakiness rather than as a refusal.
    const { mediaId } = await attached(otherPrivateChannel, key.credential);
    await send(privateChannel, mediaId, key.credential);

    // `alice` is in `privateChannel` and not in `otherPrivateChannel`.
    expect((await get(mediaId, alice)).status).toBe(200);
    // `mallory` is in neither.
    expect((await get(mediaId, mallory)).status).toBe(404);
  });
});
