import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret } from "../db/repository";
import { createDb, createPool } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";
// The comparison this suite invented, now shared. Chapter 3.12 moved it into
// `isolation/compare.ts` so 24 routes could use the same oracle; it is imported
// back rather than duplicated, which is the fault that chapter is about.
import { withoutRequestId } from "../isolation/compare";


// The endpoint path (chapter 2.2): guard → pipe → service → repository →
// filter, over real HTTP against the compose Postgres. Its own environment,
// minted here — no truncate, because tenant isolation means this suite and
// the repository suite cannot see each other's rows (2.1's property, paying
// for itself in the test lane).
describe("POST /v1/channels/:channelId/messages", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  // Chapter 3.2: the tenant arrives as a CREDENTIAL now, not as a header. The
  // suite mints its own key the same way signup does — through the repository's
  // admin surface — so nothing here needs a test-only route to exist.
  let credential: string;
  let channelId: string;
  let foreignChannelId: string;
  let privateChannelId: string;
  let tokenFor: (user: string) => Promise<string>;

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "messages-itest" });
    channelId = (
      await new Repository(db, env.id).createChannel("general", "public")
    ).id;
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    const other = await createEnvironment(db, { name: "messages-itest-other" });
    foreignChannelId = (
      await new Repository(db, other.id).createChannel("theirs", "public")
    ).id;

    // Chapter 3.15's fixtures: a private channel, one member, one stranger of the
    // SAME tenant, and a way to mint their tokens. The private channel is created
    // through the repository because `POST /v1/channels` does not accept `private`
    // until the read paths enforce it (FR-009's ordering).
    const repo = new Repository(db, env.id);
    privateChannelId = (await repo.createChannel("members-only", "private")).id;
    const member = await repo.createUser("insider", "An Insider");
    await repo.addMember(privateChannelId, member.id);
    await repo.createUser("outsider", "An Outsider");
    const signingSecret = (await environmentSigningSecret(db, env.id))!
      .signingSecret;
    tokenFor = async (subject: string) =>
      (
        await mintUserToken(signingSecret, {
          user: subject,
          environmentId: env.id,
          ttlSeconds: 3600,
        })
      ).token;
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (body: unknown, channel = channelId, key = credential) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

  it("returns 201 with an ascending sequence", async () => {
    const first = await send({ text: "hello" });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { seq: number };
    const b = (await (await send({ text: "again" })).json()) as { seq: number };
    expect(b.seq).toBe(a.seq + 1);
  });

  it("rejects a malformed body through the protocol envelope", async () => {
    const res = await send({ text: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "invalid_request" });
    expect(typeof body.docs_url).toBe("string");
  });

  it("answers a foreign channel's HISTORY with that same 404 (chapter 2.8)", async () => {
    // The milestone suite found the two doors disagreeing: POST said 404 for
    // a channel this tenant cannot see, GET said 200 with an empty page. An
    // empty page leaks nothing, but it leaves a client unable to tell "no
    // such conversation" from "nothing said yet" — and one resource should
    // not answer two ways depending on the verb.
    const foreign = await fetch(
      `${url}/v1/channels/${foreignChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const missing = await fetch(
      `${url}/v1/channels/${crypto.randomUUID()}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  it("answers a FOREIGN channel id with the same 404 as a missing one", async () => {
    const foreign = await send({ text: "not for you" }, foreignChannelId);
    const missing = await send({ text: "nobody home" }, crypto.randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // Indistinguishable — no data, and no reveal that the id exists.
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  // ── THE ROUTE A CUSTOMER'S CLIENT ACTUALLY CALLS (chapter 3.15, FR-001) ───────
  //
  // The membership check lives in `repository.sendMessage` and is gated on `userId`
  // being present. `repository.itest.ts` proves the check EXISTS by driving that
  // function directly with a user id. Only these tests prove it FIRES, because for
  // twenty-three chapters this controller called `messages.send(channelId, body)`
  // with no user at all — and `MessagesController` declares no `@Accepts`, so the
  // guard falls back to `EITHER` and a user token is accepted here.
  //
  // So the repository test passed while the route it protects was open. A repository
  // test proves a check exists; only a route test proves it fires.
  describe("a private channel over the public route (FR-001, SC-002)", () => {
    const sendAs = async (token: string, channel: string, text = "hello") =>
      fetch(`${url}/v1/channels/${channel}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      });

    it("refuses a non-member's send with the not-found envelope, body and all", async () => {
      const token = await tokenFor("outsider");
      const refused = await sendAs(token, privateChannelId);
      const absent = await sendAs(token, "00000000-0000-4000-8000-000000000000");

      expect(refused.status).toBe(absent.status);
      // Byte-identical but for `request_id`, which is SC-002's actual requirement —
      // matching status codes is the easy half and says nothing on its own.
      // Deleting rather than destructuring: an unused binding is a lint error and
      // the intent is a removal either way. `request_id` is the one field that
      // differs by construction — it names the request, not the resource — which is
      // why chapter 3.12's oracle drops exactly this one and nothing else.
      const strip = (b: Record<string, unknown>) => {
        delete b.request_id;
        return b;
      };
      expect(strip((await refused.json()) as Record<string, unknown>)).toEqual(
        strip((await absent.json()) as Record<string, unknown>),
      );
    });

    it("accepts a member's send to the same channel", async () => {
      // The control, and it is not optional. Two refusals for unrelated reasons are
      // also indistinguishable — a token the guard rejects outright would pass the
      // test above while proving nothing about membership.
      const token = await tokenFor("insider");
      const accepted = await sendAs(token, privateChannelId, "mine to send");
      expect(accepted.status).toBe(201);
    });

    it("accepts an application key's send to the same private channel (FR-005)", async () => {
      const accepted = await send({ text: "from the tenant" }, privateChannelId);
      expect(accepted.status).toBe(201);
    });

    it("answers a non-member's history read exactly as an absent channel does", async () => {
    // T041b. The history route dropped its caller the same way the send route did,
    // and `listMessages` had no `userId` parameter to drop it INTO — so the task
    // that said "add the same check to the history path" was asking for a check
    // with nothing to check against. Three places, and a gap in any one makes a
    // check unreachable: the handler resolves, the service threads, the repository
    // accepts.
    //
    // AND THE FIRST ATTEMPT AT THIS TEST WAS WRONG IN AN INSTRUCTIVE WAY. It
    // expected an empty page, because `listMessages` answers an unknown channel id
    // with `[]` at the repository level. The ROUTE answers 404 — `messages.service`
    // checks `channelExists` first — so an empty page for a private channel would
    // have differed from an absent one and announced that the channel was there.
    // Only comparing the two answers caught it, which is the whole point of pairing
    // them rather than asserting a status.
    const outsider = await tokenFor("outsider");
    const insider = await tokenFor("insider");
    await sendAs(insider, privateChannelId, "members can read this");

    const hidden = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${outsider}` } },
    );
    const absent = await fetch(
      `${url}/v1/channels/00000000-0000-4000-8000-000000000000/messages?limit=10`,
      { headers: { authorization: `Bearer ${outsider}` } },
    );
    expect(hidden.status).toBe(absent.status);
    // The whole body, `request_id` excepted — a private channel the caller cannot
    // see and a channel that does not exist give one answer.
    expect(withoutRequestId(await hidden.json())).toEqual(
      withoutRequestId(await absent.json()),
    );
  });

  it("returns the page to a member of the same channel", async () => {
    // The control: the page exists and the reader is the variable.
    const insider = await tokenFor("insider");
    const res = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${insider}` } },
    );
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("returns the page to an application credential (FR-005)", async () => {
    const res = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("refuses a removed member's send, and their messages stay (SC-004, SC-005)", async () => {
    // T057. This is phase 3's check reading a row that is now gone — no new code
    // path, which is the point: removal takes the membership away and the check
    // that was already there does the rest.
    const token = await tokenFor("insider");
    const sent = await sendAs(token, privateChannelId, "written while a member");
    expect(sent.status).toBe(201);

    await fetch(`${url}/v1/channels/${privateChannelId}/members/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify({ user_ids: ["insider"] }),
    });

    const refused = await sendAs(token, privateChannelId, "after removal");
    const absent = await sendAs(token, "00000000-0000-4000-8000-000000000000");
    expect(refused.status).toBe(absent.status);

    // And what they wrote is still there, read with the tenant's key.
    const history = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=100`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const body = (await history.json()) as { messages: { user: string | null }[] };
    expect(body.messages.some((m) => m.user === "insider")).toBe(true);
  });

  it("refuses a token minted for an identifier with no user row", async () => {
      // `POST /auth/dev-token` mints tokens for identifiers that need not exist, so
      // before chapter 3.15 this send SUCCEEDED, unattributed — and an unattributed
      // send is one the membership check waves through. A user with no row is a
      // member of nothing. FR-039a removes the case by creating the row at mint time.
      const token = await tokenFor("never-seen-before");
      const refused = await sendAs(token, privateChannelId);
      expect(refused.status).toBe(400);
    });
  });
});
