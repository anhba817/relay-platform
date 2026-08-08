import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { createEnvironment, Repository } from "../db/repository";

// The endpoint path (chapter 2.2): guard → pipe → service → repository →
// filter, over real HTTP against the compose Postgres. Its own environment,
// minted here — no truncate, because tenant isolation means this suite and
// the repository suite cannot see each other's rows (2.1's property, paying
// for itself in the test lane).
describe("POST /v1/channels/:channelId/messages", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  let channelId: string;
  let foreignChannelId: string;

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "messages-itest" });
    channelId = (
      await new Repository(db, env.id).createChannel("general", "public")
    ).id;
    const other = await createEnvironment(db, { name: "messages-itest-other" });
    foreignChannelId = (
      await new Repository(db, other.id).createChannel("theirs", "public")
    ).id;
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (body: unknown, channel = channelId, environment = env.id) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-environment": environment,
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
      { headers: { "x-relay-environment": env.id } },
    );
    const missing = await fetch(
      `${url}/v1/channels/${crypto.randomUUID()}/messages?limit=10`,
      { headers: { "x-relay-environment": env.id } },
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("answers a FOREIGN channel id with the same 404 as a missing one", async () => {
    const foreign = await send({ text: "not for you" }, foreignChannelId);
    const missing = await send({ text: "nobody home" }, crypto.randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // Indistinguishable — no data, and no reveal that the id exists.
    expect(await foreign.json()).toEqual(await missing.json());
  });
});
