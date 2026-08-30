import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  internalSendResponseSchema,
  internalMembershipsResponseSchema,
  internalSessionResponseSchema,
} from "@relay/protocol";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import {
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";

// The internal boundary, tested as a CONTRACT (chapter 2.6). 2.5 built these
// routes and verified them only through the gateway's tests, where the api
// was a stub — which means nothing checked that the real api emits what the
// shared schema demands. The gateway parses these bodies at runtime and
// refuses what does not fit, so an unnoticed drift here becomes a failed
// send in production; asserting the schema HERE turns that into a red test.
//
// Both response schemas are z.strictObject: an extra field fails exactly as
// loudly as a missing one. That is deliberate for a contract whose two sides
// deploy together.
describe("the internal surface", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  let channelId: string;
  let privateChannelId: string;
  /** Chapter 3.2: the gateway forwards the END USER'S token instead of
   * asserting two identity headers, so this suite mints tokens the same way the
   * dev-token endpoint does — with the environment's own signing secret. */
  let tokenFor: (user: string) => Promise<string>;

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "internal-itest" });
    const repo = new Repository(db, env.id);
    const user = await repo.createUser("tuan", "Tuan");
    channelId = (await repo.createChannel("fleet", "public")).id;
    await repo.addMember(channelId, user.id);
    // Chapter 3.15: the socket's route reaches the same `sendMessage`, so the
    // membership check has to hold here too — this is the caller R1 counted and
    // the one that always supplied a user.
    privateChannelId = (await repo.createChannel("fleet-private", "private")).id;
    await repo.addMember(privateChannelId, user.id);
    await repo.createUser("stranger", "A Stranger");
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

  const headers = async (user = "tuan") => ({
    "content-type": "application/json",
    authorization: `Bearer ${await tokenFor(user)}`,
  });

  const send = async (body: unknown, user = "tuan") =>
    fetch(`${url}/internal/messages`, {
      method: "POST",
      headers: await headers(user),
      body: JSON.stringify(body),
    });

  it("emits a send response the shared contract accepts", async () => {
    const res = await send({ channel_id: channelId, text: "which entrance?" });
    expect(res.status).toBe(201);
    const parsed = internalSendResponseSchema.safeParse(await res.json());
    // The error is printed on failure because "shape drift" is useless as a
    // diagnosis; the field name is the whole story.
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    // The field this chapter had to add: a frame cannot name its sender if
    // the write path does not record one.
    expect(parsed.data?.user).toBe("tuan");
  });

  it("reports a recognised retry as a duplicate, once (FR-MSG-04)", async () => {
    const body = { channel_id: channelId, text: "B2", idempotency_key: "k-1" };
    const first = internalSendResponseSchema.parse(
      await (await send(body)).json(),
    );
    const retry = internalSendResponseSchema.parse(
      await (await send(body)).json(),
    );
    // Same message, both times — and the internal caller is TOLD, because
    // it has to decide whether anyone else hears about it (the fan-out
    // republish trap). The public route keeps this invisible.
    expect(retry.id).toBe(first.id);
    expect(retry.seq).toBe(first.seq);
    expect(first.duplicate).toBeUndefined();
    expect(retry.duplicate).toBe(true);
  });

  it("persists the sender on the row, not just in the response", async () => {
    const res = internalSendResponseSchema.parse(
      await (await send({ channel_id: channelId, text: "north ramp" })).json(),
    );
    const history = await fetch(
      `${url}/v1/channels/${channelId}/messages?limit=50`,
      { headers: await headers() },
    );
    const page = (await history.json()) as { messages: { id: string }[] };
    // History does not expose `user` yet — 2.7's resume path is where the
    // read side catches up. What this asserts is that the message exists
    // and the write did not fail silently while claiming a sender.
    expect(page.messages.some((m) => m.id === res.id)).toBe(true);
  });

  // Chapter 3.2 replaced `GET /internal/memberships` with
  // `POST /internal/session`. These two cases held that route's contract, and
  // they move rather than disappear: the route changed, the guarantees did not.
  // The answer now carries the identity as well, because the gateway no longer
  // decides it (research R1).
  it("emits a session response the shared contract accepts", async () => {
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: await headers(),
    });
    const parsed = internalSessionResponseSchema.safeParse(await res.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.channel_ids).toContain(channelId);
    // The half that is new: the api says who the token belongs to.
    expect(parsed.data?.user).toBe("tuan");
    expect(parsed.data?.environment_id).toBe(env.id);
  });

  it("answers for an unknown user with no channels rather than an error", async () => {
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: await headers("nobody-here"),
    });
    expect(res.status).toBe(200);
    expect(
      internalSessionResponseSchema.parse(await res.json()).channel_ids,
    ).toEqual([]);
  });

  it("refuses an unverifiable token instead of answering for it", async () => {
    // The refusal the gateway turns into a 4001. It exists here because the
    // route that verifies is the route that must refuse — the gateway holds no
    // secret and cannot tell a good token from a bad one any more.
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(res.status).toBe(401);
  });

  // ── THE BACKSTOP'S ROUTE (chapter 3.20, FR-017) ─────────────────────────────
  //
  // `GET /internal/memberships` is the one question a periodic re-read has. It was
  // exercised end to end from the gateway's suite the moment it shipped — and the
  // coverage ratchet still read **28.57% statements, 0% branches** for it, because
  // that suite runs in another package and this one is where the api's coverage is
  // measured. A route can be thoroughly tested and completely uncovered.
  it("answers the caller's own channels, in the contract's shape", async () => {
    const res = await fetch(`${url}/internal/memberships`, {
      headers: await headers(),
    });
    expect(res.status).toBe(200);
    const parsed = internalMembershipsResponseSchema.safeParse(await res.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.channel_ids).toContain(channelId);
  });

  it("answers a user with no row as a user with no channels", async () => {
    // The branch the backstop depends on. A re-read that threw for a deleted user
    // would turn a routine refresh into a failure the gateway has to interpret, and
    // 2.5's rule already says a token for an unseen user is a user with no channels
    // rather than an error.
    const res = await fetch(`${url}/internal/memberships`, {
      headers: await headers("nobody-here"),
    });
    expect(res.status).toBe(200);
    expect(
      internalMembershipsResponseSchema.parse(await res.json()).channel_ids,
    ).toEqual([]);
  });

  it("refuses an unverifiable token", async () => {
    const res = await fetch(`${url}/internal/memberships`, {
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(res.status).toBe(401);
  });

  it("answers a POST with 404, which is what keeps the signup fixture standing", async () => {
    // NOT A FORMALITY. `services/api/src/tenancy/signup.itest.ts` POSTs this path
    // with no credential and asserts the status is not 200 — a check written when
    // the route did not exist. A GET-only route answers a POST with 404, so that
    // assertion still means what it meant. Registering `ALL` or adding a POST twin
    // is what would break it, and this is the test that would notice.
    const res = await fetch(`${url}/internal/memberships`, {
      method: "POST",
      headers: await headers(),
    });
    expect(res.status).toBe(404);
  });

  // ── THE SOCKET'S ROUTE INHERITS THE CHECK (chapter 3.15, FR-001) ────────────
  //
  // `POST /internal/messages` resolves the user from the forwarded token and then
  // calls the same `messages.send` the public route does, so one check in
  // `repository.sendMessage` covers both doors. Chapter 3.12 recorded this route
  // as checking nothing; what it was missing was a check, not a caller — it has
  // always supplied `user.id` (`internal.controller.ts:65`).
  it("refuses a non-member's send to a private channel, as if it were absent", async () => {
    const refused = await send(
      { channel_id: privateChannelId, text: "not mine" },
      "stranger",
    );
    const absent = await send(
      { channel_id: "00000000-0000-4000-8000-000000000000", text: "nowhere" },
      "stranger",
    );
    expect(refused.status).toBe(absent.status);
  });

  it("accepts a member's send to the same private channel", async () => {
    const accepted = await send(
      { channel_id: privateChannelId, text: "mine to send" },
      "tuan",
    );
    expect(accepted.status).toBe(201);
  });

  // ── THE SESSION CARRIES MEMBERSHIPS, WHICH IS WHY IT NEEDED NO CHANGE ───────
  //
  // T042. `session.controller` builds its channel list from
  // `repository.channelsForUser`, which selects from `members` joined to `users`
  // and filters on both the user and the environment. So a private channel a user
  // is not a member of cannot enter a session — and neither can a PUBLIC one,
  // which is FR-004's other half: the subscription set is not the read set.
  //
  // A CONFIRMATION RATHER THAN A CHECK, and the test says so. R2 measured this by
  // reading the query; this asserts it against a running one, which is the
  // difference between believing a comment and knowing.
  it("names neither a private nor a public channel the user is not a member of", async () => {
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: await headers("stranger"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_ids: string[] };
    expect(body.channel_ids).not.toContain(privateChannelId);
    // `channelId` is the PUBLIC channel this suite's other user belongs to. The
    // stranger can read it by id and send to it, and it is still not in their
    // session: membership decides subscription, visibility decides reads.
    expect(body.channel_ids).not.toContain(channelId);
  });

  it("names a channel the user IS a member of", async () => {
    // The control. An empty list would satisfy the assertions above while proving
    // that the session is broken rather than that it is scoped.
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: await headers("tuan"),
    });
    const body = (await res.json()) as { channel_ids: string[] };
    expect(body.channel_ids).toContain(privateChannelId);
  });
});
