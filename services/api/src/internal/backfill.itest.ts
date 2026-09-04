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
import { sql } from "drizzle-orm";

import { createDb, createPool } from "../db/client";
import {
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";

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
  /** Chapter 3.2: the gateway forwards the user's own token now, so the suite
   * mints one per subject rather than asserting a name in a header. */
  let tokenFor: (user: string) => Promise<string>;

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
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  const ask = async (cursors: Record<string, number>, user = "tuan") =>
    fetch(`${url}/internal/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await tokenFor(user)}`,
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

  it("replays two attachments in the order they were sent (T052, FR-010 (3.24), SC-005 (3.24))", async () => {
    // SC-005: A CLIENT THAT WAS AWAY ENDS WITH THE SAME VIEW AS ONE THAT STAYED. The
    // replay is a different code path from delivery — it maps rows out of the database
    // rather than passing a payload along — so a field threaded correctly through every
    // live path can still be missing here.
    //
    // TWO, AND IN ORDER. FR-006 says order holds on every path that returns a message,
    // and a single-attachment test cannot see an order at all.
    const sent = await repo.sendMessage(channelId, {
      text: "away across this one",
      userId: tuan.id,
      attachments: [
        { type: "url", kind: "image", url: "https://example.test/replay-first.png" },
        { type: "url", kind: "video", url: "https://example.test/replay-second.mp4" },
      ],
    });

    const body = await parsed(await ask({ [channelId]: sent.seq - 1 }));
    const page = body.channels[channelId]!;
    const frame = page.messages.find((m) => m.seq === sent.seq)!;
    expect(frame.attachments.map((a) => (a.type === "url" ? a.url : "media"))).toEqual([
      "https://example.test/replay-first.png",
      "https://example.test/replay-second.mp4",
    ]);
  });

  it("replays a message with none as an empty list (FR-007 (3.24))", async () => {
    const sent = await say(channelId, "nothing attached");
    const body = await parsed(await ask({ [channelId]: sent.seq - 1 }));
    const frame = body.channels[channelId]!.messages.find((m) => m.seq === sent.seq)!;
    // `toHaveProperty` rather than `toEqual([])`: an absent key satisfies the latter when
    // the value is undefined, and `messageSchema` requires the field on this frame.
    expect(frame).toHaveProperty("attachments", []);
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
    // PLANTED, BECAUSE NOTHING CAN WRITE ONE ANY MORE (chapter 3.17, T014a, FR-014).
    //
    // This is the SECOND test whose subject is a senderless row, and T014a named only
    // the first — `repository.itest.ts`'s `last_message.user` arm. Both had to stop
    // using `sendMessage` for the same reason: FR-MSG-15 makes the sender required, so
    // the repository can no longer produce the fixture that proves what happens without
    // one. Found by the compiler rather than by reading, which is what Phase 2 is for.
    //
    // The shape is still real: every row written through the socket before 2.6's fix
    // looks like this, and `toFrame` skipping them is the behaviour under test.
    const anonymousSeq = 1;
    const raw = createDb(createPool());
    await raw.execute(
      sql`INSERT INTO messages (id, channel_id, sequence, text, created_at)
          VALUES (gen_random_uuid(), ${orphans}, ${anonymousSeq}, 'who said it?', now())`,
    );
    await raw.execute(
      sql`UPDATE channels SET last_sequence = ${anonymousSeq}, last_activity_at = now()
          WHERE id = ${orphans}`,
    );
    const anonymous = { seq: anonymousSeq };
    const withAuthor = await say(orphans, "this one is attributable");
    const page = (await parsed(await ask({ [orphans]: 0 }))).channels[orphans]!;
    expect(page.messages.map((m) => m.seq)).toEqual([withAuthor.seq]);
    // The gap is visible to the client as a missing sequence number — which
    // is precisely the signal the SDK repairs through 2.4's history endpoint.
    expect(page.messages.map((m) => m.seq)).not.toContain(anonymous.seq);
  });

  // ══ WHAT A CLIENT THAT WAS AWAY CAN AND CANNOT LEARN (chapter 3.23, US4) ══
  //
  // **THESE TESTS MOVED HERE FROM `services/gateway/src/resume.itest.ts`**, which the
  // task list named. That file boots the gateway against a **stubbed** api: its
  // `environment_id: "env-1"` and `user: "tuan"` are stub return values and there is no
  // database behind it, so nothing in it can edit or delete a message. What FR-016 and
  // FR-016a are ABOUT is what the backfill returns, and that is this file's subject —
  // a real repository, real rows, and the mapping in `backfill.controller.ts`.
  //
  // The gateway's half is that it replays what it was handed, which `resume.itest.ts`
  // does test, with a stub that says so.

  it("a message ABOVE the cursor, edited while away, replays with its CURRENT text (FR-016)", async () => {
    // THE BACKFILL READS ROWS, IT DOES NOT REPLAY A LOG. That is the whole of FR-016's
    // answer and it is a property of the query rather than a feature anybody built: the
    // superseded text lives in `message_edits`, which no read path on this route
    // touches, so a client that was away sees what the message says NOW.
    const channel = (await repo.createChannel("resume-edited", "public")).id;
    await repo.addMember(channel, tuan.id);
    const sent = await say(channel, "the frist draft");
    await repo.editMessage(channel, sent.id, { text: "the first draft", userId: tuan.id });

    const page = (await parsed(await ask({ [channel]: 0 }))).channels[channel]!;
    expect(page.messages.map((m) => m.seq)).toEqual([sent.seq]);
    expect(page.messages[0]!.text).toBe("the first draft");
    // AND NOT THE SUPERSEDED TEXT, asserted separately — a page that contained both
    // would satisfy the assertion above.
    expect(page.messages.map((m) => m.text)).not.toContain("the frist draft");
  });

  it("a message DELETED while away is not replayed at all (FR-016)", async () => {
    // `backfill.controller.ts`'s `toFrame` already drops a null-text row and its comment
    // says why: a tombstone is not a creation, and there is no truthful `text` to
    // invent. **This is the first test with a real writer behind that line** — the
    // senderless test above plants its row by hand precisely because nothing could
    // write one.
    const channel = (await repo.createChannel("resume-deleted", "public")).id;
    await repo.addMember(channel, tuan.id);
    const kept = await say(channel, "still here");
    const gone = await say(channel, "not for long");
    await repo.deleteMessage(channel, gone.id, { userId: tuan.id });

    const page = (await parsed(await ask({ [channel]: 0 }))).channels[channel]!;
    expect(page.messages.map((m) => m.seq)).toEqual([kept.seq]);
    // THE CONTENT IS THE ASSERTION, not the count: a page that carried the tombstone
    // with a null text would be a `message.created` frame the contract forbids, and a
    // page that carried the OLD text would be the deletion undone.
    expect(page.messages.map((m) => m.text)).not.toContain("not for long");
    // The client sees a gap at `gone.seq` and repairs it through history, which is the
    // safety net `toFrame`'s comment names.
    expect(page.messages.map((m) => m.seq)).not.toContain(gone.seq);
  });

  it("truncation is reported as the READ found it, tombstones and all", async () => {
    // `backfill.controller.ts:64` decided this and says why — *"dropping an unrenderable
    // row does not mean the client should go page history, and hiding a real cap
    // would"* — and `repository.ts` computes it as `rows.length > limit`. **The decision
    // is not this chapter's and the exercise is**: until now no writer could produce a
    // tombstone, so a truncated page containing one had never happened.
    //
    // A FULL PAGE PLUS ONE, WITH ONE ROW DELETED. The page must report fewer frames
    // than the limit AND still say it was truncated.
    const channel = (await repo.createChannel("resume-truncated", "public")).id;
    await repo.addMember(channel, tuan.id);
    const sent = [];
    for (let i = 0; i < BACKFILL_LIMIT + 1; i++) sent.push(await say(channel, `m${i}`));
    // Delete one INSIDE the page the read will return — the oldest, which the cap keeps.
    await repo.deleteMessage(channel, sent[0]!.id, { userId: tuan.id });

    const page = (await parsed(await ask({ [channel]: 0 }))).channels[channel]!;
    expect(page.truncated).toBe(true);
    // FEWER FRAMES THAN ROWS READ, which is the half that would break if `truncated`
    // were computed after the mapping.
    expect(page.messages.length).toBe(BACKFILL_LIMIT - 1);
  }, 120_000);

  it("a message BELOW the cursor, edited while away, produces no frame and no gap (FR-016a)", async () => {
    // THE SOFT EDGE IN THE CONTRACT, demonstrated rather than asserted. Resume is
    // ordered by the channel sequence alone: a message older than the cursor is not in
    // the page whatever happened to it, so an edit below the cursor is invisible.
    //
    // **BOTH HALVES.** No frame is the obvious one. The one that matters is NO GAP: the
    // sequence numbers above the cursor are contiguous, so the SDK's gap detector — the
    // mechanism every other missed frame is repaired by — sees nothing to repair. That
    // is why FR-016b asks for the bound to be documented as a property of a cursor.
    const channel = (await repo.createChannel("resume-below", "public")).id;
    await repo.addMember(channel, tuan.id);
    const below = await say(channel, "said long ago");
    const cursor = below.seq;
    const above = await say(channel, "said since");
    await repo.editMessage(channel, below.id, {
      text: "said long ago, corrected",
      userId: tuan.id,
    });

    const page = (await parsed(await ask({ [channel]: cursor }))).channels[channel]!;
    expect(page.messages.map((m) => m.seq)).toEqual([above.seq]);
    expect(page.messages.map((m) => m.text)).not.toContain("said long ago, corrected");
    // NO GAP: the page starts at cursor + 1 and every step is 1.
    const seqs = page.messages.map((m) => m.seq);
    expect(seqs[0]).toBe(cursor + 1);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
  });

  it("re-reading the range through history repairs it (SC-006)", async () => {
    // THE DOCUMENTED REPAIR, end to end. A client away across an edit below its cursor
    // and a deletion above it re-reads the range and ends with what a client that never
    // left is holding: the current text for the edit, and a tombstone for the deletion.
    //
    // `listMessages` IS THE HISTORY ROUTE'S READ, so this is the repair the SDK
    // performs rather than a second implementation of it.
    const channel = (await repo.createChannel("resume-repair", "public")).id;
    await repo.addMember(channel, tuan.id);
    const below = await say(channel, "before the cursor");
    const cursor = below.seq;
    const above = await say(channel, "after the cursor");
    const doomed = await say(channel, "about to go");
    await repo.editMessage(channel, below.id, {
      text: "before the cursor, corrected",
      userId: tuan.id,
    });
    await repo.deleteMessage(channel, doomed.id, { userId: tuan.id });

    // What resume alone hands the client: one frame, and a gap at `doomed.seq`.
    const page = (await parsed(await ask({ [channel]: cursor }))).channels[channel]!;
    expect(page.messages.map((m) => m.seq)).toEqual([above.seq]);

    // What the repair adds. Read from the start, the way a client that distrusts its
    // cache does.
    const repaired = await repo.listMessages(channel, {
      userId: tuan.id,
      limit: 50,
      afterSeq: 0,
    });
    const bySeq = new Map(repaired.map((m) => [m.seq, m]));
    expect(bySeq.get(below.seq)!.text).toBe("before the cursor, corrected");
    expect(bySeq.get(above.seq)!.text).toBe("after the cursor");
    // THE TOMBSTONE IS PRESENT AND EMPTY, which is what closes the gap resume left —
    // the client learns the sequence is accounted for rather than missing.
    expect(bySeq.has(doomed.seq)).toBe(true);
    expect(bySeq.get(doomed.seq)!.text).toBeNull();
    // And every sequence in the range is accounted for, which is the property SC-006
    // asks for: the same view as a client that stayed connected.
    expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual([
      below.seq,
      above.seq,
      doomed.seq,
    ]);
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
