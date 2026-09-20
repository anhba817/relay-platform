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

  const slot = async (credential: string) => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "p.png", mime_type: "image/png", bytes: 1024 }),
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

  /** A referenced, readable object in one call: slot, upload bytes, send. */
  const attached = async (
    channel: string,
    credential: string,
    bytes = `bytes ${randomUUID()}`,
  ): Promise<{ mediaId: string; bytes: string; messageId: string }> => {
    const issued = await slot(credential);
    const put = await fetch(issued.upload_url, { method: "PUT", body: bytes });
    expect(put.status, "the fixture could not upload its own bytes").toBe(200);
    const message = await send(channel, issued.media_id, credential);
    return { mediaId: issued.media_id, bytes, messageId: message.id };
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
    expect(await fetched.text()).toBe(bytes);
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
    const issued = await slot(key.credential);
    await fetch(issued.upload_url, { method: "PUT", body: "nobody may read this" });
    expect((await get(issued.media_id, key.credential)).status).toBe(404);
  });

  it("gives all four refusals ONE body, compared whole", async () => {
    // THE CODE IS NOT THE ORACLE. A message or an extra field leaks existence exactly as
    // well as a code does, so the comparison is over the whole body with `request_id`
    // removed — the only field that is allowed to differ.
    const foreign = await attached(publicChannel, key.credential);
    const unreadable = await attached(privateChannel, key.credential);
    const orphan = await slot(key.credential);

    const bodies = await Promise.all(
      [
        get(foreign.mediaId, otherKey.credential),
        get(unreadable.mediaId, mallory),
        get(randomUUID(), key.credential),
        get(orphan.media_id, key.credential),
      ].map(async (p) => {
        const res = await p;
        expect(res.status).toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        delete body["request_id"];
        return body;
      }),
    );

    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: "not_found" });
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
