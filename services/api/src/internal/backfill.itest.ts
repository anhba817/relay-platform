import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BACKFILL_LIMIT,
  internalBackfillResponseSchema,
  MAX_RESUME_CHANNELS,
} from "@relay/protocol";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { createEnvironment, Repository } from "../db/repository";

// The api's half of resume (chapter 2.7), against the compose Postgres. The
// gateway's suites prove the ORDERING; this one proves the read: everything
// past the cursor, capped honestly, scoped to membership as it stands now.

describe("POST /internal/backfill", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  let repo: Repository;
  let channelId: string;
  let quietChannelId: string;
  let leftChannelId: string;
  let tuan: { id: string };

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "backfill-itest" });
    repo = new Repository(db, env.id);
    tuan = await repo.createUser("tuan", "Tuan");
    const dispatcher = await repo.createUser("dispatcher", "Dispatcher");
    channelId = (await repo.createChannel("fleet", "public")).id;
    quietChannelId = (await repo.createChannel("quiet", "public")).id;
    leftChannelId = (await repo.createChannel("left", "public")).id;
    for (const id of [channelId, quietChannelId]) {
      await repo.addMember(id, tuan.id);
      await repo.addMember(id, dispatcher.id);
    }
    // Tuan is NOT a member of leftChannelId — the "removed while offline"
    // case, which is indistinguishable from "never joined" by design.
    await repo.addMember(leftChannelId, dispatcher.id);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  const ask = (cursors: Record<string, number>, user = "tuan") =>
    fetch(`${url}/internal/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-environment": env.id,
        "x-relay-user": user,
      },
      body: JSON.stringify({ cursors }),
    });

  const parsed = async (res: Response) =>
    internalBackfillResponseSchema.parse(await res.json());

  /** Messages arrive through the repository with an author, because a frame
   * without one cannot exist (2.6's fix, 2.7's dependency). */
  const say = (channel: string, text: string) =>
    repo.sendMessage(channel, { text, userId: tuan.id });

  it("returns everything after the cursor as wire frames, in sequence order", async () => {
    const a = await say(channelId, "B2, north ramp");
    const b = await say(channelId, "which entrance?");
    const body = await parsed(await ask({ [channelId]: a.seq - 1 }));
    const page = body.channels[channelId]!;
    expect(page.messages.map((m) => m.seq)).toEqual([a.seq, b.seq]);
    expect(page.truncated).toBe(false);
    // The frame is complete enough to deliver as-is: this is the same shape
    // the live path publishes, which is the entire point of returning frames
    // instead of rows.
    expect(page.messages[0]).toMatchObject({
      id: a.id,
      channel: channelId,
      seq: a.seq,
      user: "tuan",
      text: "B2, north ramp",
    });
  });

  it("excludes the cursor's own message — the anchor is exclusive", async () => {
    const a = await say(channelId, "already applied");
    const body = await parsed(await ask({ [channelId]: a.seq }));
    expect(body.channels[channelId]!.messages.map((m) => m.seq)).not.toContain(
      a.seq,
    );
  });

  it("answers a caught-up cursor with an empty page, not an absent channel", async () => {
    // "Nothing new" and "no such channel" must not look the same: the client
    // uses the difference to decide whether its cursor is still valid.
    const body = await parsed(await ask({ [quietChannelId]: 0 }));
    expect(body.channels[quietChannelId]).toEqual({
      messages: [],
      truncated: false,
    });
  });

  it("caps the page and says so (FR-RTM-04)", async () => {
    const flood = (await repo.createChannel("flood", "public")).id;
    await repo.addMember(flood, tuan.id);
    // One past the ceiling, so the cap and the flag are both exercised.
    for (let i = 0; i < BACKFILL_LIMIT + 1; i++) {
      await say(flood, `m${i}`);
    }
    const page = (await parsed(await ask({ [flood]: 0 }))).channels[flood]!;
    expect(page.messages.length).toBe(BACKFILL_LIMIT);
    expect(page.truncated).toBe(true);
    // Capped from the OLDEST end: resume is a catch-up, so the client keeps
    // reading forward from where the page stops rather than guessing at a
    // hole in the middle.
    expect(page.messages[0]!.seq).toBe(1);
    expect(page.messages.at(-1)!.seq).toBe(BACKFILL_LIMIT);
  }, 120_000);

  it("evaluates membership NOW, not when the cursor was minted", async () => {
    await repo.sendMessage(leftChannelId, {
      text: "not for tuan",
      userId: tuan.id,
    });
    const body = await parsed(await ask({ [leftChannelId]: 0 }));
    // Absent entirely — a channel the user is not in backfills nothing, and
    // says nothing about whether it exists (constitution I, FR-TEN-05).
    expect(body.channels[leftChannelId]).toBeUndefined();
  });

  it("treats a foreign tenant's channel id as a channel that is not there", async () => {
    const db = createDb(createPool());
    const other = await createEnvironment(db, { name: "backfill-itest-other" });
    const theirs = (
      await new Repository(db, other.id).createChannel("theirs", "public")
    ).id;
    const body = await parsed(await ask({ [theirs]: 0 }));
    expect(body.channels[theirs]).toBeUndefined();
  });

  it("skips a message no frame can be built from, rather than inventing one", async () => {
    const orphans = (await repo.createChannel("orphans", "public")).id;
    await repo.addMember(orphans, tuan.id);
    // No userId: the shape of every row written through the socket before
    // 2.6's fix. There is no truthful sender to put on the wire.
    const anonymous = await repo.sendMessage(orphans, { text: "who said it?" });
    const withAuthor = await say(orphans, "this one is attributable");
    const page = (await parsed(await ask({ [orphans]: 0 }))).channels[orphans]!;
    expect(page.messages.map((m) => m.seq)).toEqual([withAuthor.seq]);
    // The gap is visible to the client as a missing sequence number — which
    // is precisely the signal the SDK repairs through 2.4's history endpoint.
    expect(page.messages.map((m) => m.seq)).not.toContain(anonymous.seq);
  });

  it("refuses a cursor map big enough to turn one connect into a scan storm", async () => {
    const cursors: Record<string, number> = {};
    for (let i = 0; i <= MAX_RESUME_CHANNELS; i++) {
      cursors[`channel-${i}`] = 1;
    }
    expect((await ask(cursors)).status).toBe(400);
  });

  it("resumes nothing for a user the environment has never seen", async () => {
    const body = await parsed(await ask({ [channelId]: 0 }, "nobody-here"));
    expect(body.channels).toEqual({});
  });
});
