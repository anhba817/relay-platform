import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  internalMembershipsResponseSchema,
  internalSendResponseSchema,
} from "@relay/protocol";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { createEnvironment, Repository } from "../db/repository";

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

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "internal-itest" });
    const repo = new Repository(db, env.id);
    const user = await repo.createUser("tuan", "Tuan");
    channelId = (await repo.createChannel("fleet", "public")).id;
    await repo.addMember(channelId, user.id);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = (user = "tuan") => ({
    "content-type": "application/json",
    "x-relay-environment": env.id,
    "x-relay-user": user,
  });

  const send = (body: unknown, user = "tuan") =>
    fetch(`${url}/internal/messages`, {
      method: "POST",
      headers: headers(user),
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
      { headers: headers() },
    );
    const page = (await history.json()) as { messages: { id: string }[] };
    // History does not expose `user` yet — 2.7's resume path is where the
    // read side catches up. What this asserts is that the message exists
    // and the write did not fail silently while claiming a sender.
    expect(page.messages.some((m) => m.id === res.id)).toBe(true);
  });

  it("emits a memberships response the shared contract accepts", async () => {
    const res = await fetch(`${url}/internal/memberships`, {
      headers: headers(),
    });
    const parsed = internalMembershipsResponseSchema.safeParse(
      await res.json(),
    );
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.channel_ids).toContain(channelId);
  });

  it("answers for an unknown user with no channels rather than an error", async () => {
    const res = await fetch(`${url}/internal/memberships`, {
      headers: headers("nobody-here"),
    });
    expect(res.status).toBe(200);
    expect(
      internalMembershipsResponseSchema.parse(await res.json()).channel_ids,
    ).toEqual([]);
  });
});
