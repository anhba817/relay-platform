import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  createDb,
  createPool,
  DEFAULT_DATABASE_URL,
  type Db,
} from "../db/client";
import { migrate } from "../db/migrate";
import { createEnvironment, Repository } from "../db/repository";
import { decodeCursor, encodeCursor } from "./cursor";

// The history suite (chapter 2.4): offset drift staged and then retired,
// cursor stability under live inserts, the exclusive-anchor seam, both
// directions, and the page cap.

const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}") — never point this suite at a shared database`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let repo: Repository;

// A REAL SENDER FOR THE WHOLE SUITE (chapter 3.17, FR-MSG-15). History is about
// paging and ordering, not about who wrote what, so one row serves every page.
let sender: string;

beforeAll(async () => {
  await migrate(pool);
  const env = await createEnvironment(db, { name: "history-itest" });
  repo = new Repository(db, env.id);
  sender = (await repo.createUser("history-sender", "History Sender")).id;
});

// ── T052: what history shows for a legacy senderless row (SC-008, FR-013) ──
//
// PLANTED, BECAUSE NOTHING CAN WRITE ONE ANY MORE. `sendMessage` requires a sender as of
// FR-MSG-15, so the fixture for "a row with no sender" has to be inserted directly — the
// same technique as `repository.itest.ts`'s listing arm and `backfill.itest.ts`'s drop.
//
// 121,250 of the 394,808 messages in this lane have no sender (T050). Any deployment that
// has been running since before this chapter has them, which is why FR-012 asks that all
// four read paths keep working rather than treating them as a curiosity.
async function plantSenderless(channelId: string, seq: number, text: string) {
  await db.execute(
    sql`INSERT INTO messages (id, channel_id, sequence, text, created_at)
        VALUES (gen_random_uuid(), ${channelId}, ${seq}, ${text}, now())`,
  );
  await db.execute(
    sql`UPDATE channels SET last_sequence = greatest(last_sequence, ${seq})
        WHERE id = ${channelId}`,
  );
}

async function seed(channelId: string, count: number, prefix: string) {
  for (let i = 1; i <= count; i += 1) {
    await repo.sendMessage(channelId, { text: `${prefix}-${i}`, userId: sender });
  }
}

describe("history pagination (FR-MSG-09)", () => {
  it("cursor pagination is stable under the same live inserts", async () => {
    const channel = await repo.createChannel("hist-cursor", "public");
    await seed(channel.id, 60, "m");
    const page1 = await repo.listMessages(channel.id, { limit: 50 });
    await seed(channel.id, 3, "live");
    const page2 = await repo.listMessages(channel.id, {
      beforeSeq: page1[page1.length - 1]!.seq,
      limit: 50,
    });
    const seen = new Set(page1.map((m) => m.id));
    expect(page2.filter((m) => seen.has(m.id))).toHaveLength(0);
    // And nothing was skipped: the two pages are contiguous by sequence.
    expect(page2[0]!.seq).toBe(page1[page1.length - 1]!.seq - 1);
  });

  it("the anchor is exclusive — the seam row appears exactly once", async () => {
    const channel = await repo.createChannel("hist-seam", "public");
    await seed(channel.id, 20, "m");
    const page1 = await repo.listMessages(channel.id, { limit: 10 });
    const seam = page1[page1.length - 1]!;
    const page2 = await repo.listMessages(channel.id, {
      beforeSeq: seam.seq,
      limit: 10,
    });
    expect(page2.map((m) => m.seq)).not.toContain(seam.seq);
    expect(page2[0]!.seq).toBe(seam.seq - 1);
  });

  it("reads newer as well as older — the catch-up direction 2.7 will reuse", async () => {
    const channel = await repo.createChannel("hist-newer", "public");
    await seed(channel.id, 10, "m");
    const newer = await repo.listMessages(channel.id, {
      afterSeq: 7,
      limit: 10,
    });
    expect(newer.map((m) => m.seq)).toEqual([8, 9, 10]);
  });

  it("a foreign channel's history is empty, not forbidden", async () => {
    const other = await createEnvironment(db, { name: "history-itest-other" });
    const theirs = await new Repository(db, other.id).createChannel(
      "hist-theirs",
      "public",
    );
    const theirSender = (
      await new Repository(db, other.id).createUser(`h-${randomUUID().slice(0, 8)}`)
    ).id;
    await new Repository(db, other.id).sendMessage(theirs.id, {
      userId: theirSender,
      text: "theirs",
    });
    expect(await repo.listMessages(theirs.id, { limit: 50 })).toEqual([]);
  });

  it("cursors survive the round trip the endpoint makes", async () => {
    const channel = await repo.createChannel("hist-codec", "public");
    await seed(channel.id, 3, "m");
    const page = await repo.listMessages(channel.id, { limit: 2 });
    const token = encodeCursor(page[page.length - 1]!.seq);
    const next = await repo.listMessages(channel.id, {
      beforeSeq: decodeCursor(token)!,
      limit: 2,
    });
    expect(next[0]!.seq).toBe(1);
  });

  it("shows a legacy senderless row with user: null, and keeps it in the page", async () => {
    const channel = await repo.createChannel(`legacy-${Date.now()}`, "public");
    await plantSenderless(channel.id, 1, "written before there were senders");
    await repo.sendMessage(channel.id, {
      text: "written after",
      userId: sender,
    });

    const page = await repo.listMessages(channel.id, { limit: 10 });
    // BOTH ROWS ARE THERE. History's contract permits a null sender, so the legacy row is
    // readable — it is not hidden, and its sequence number is not a gap.
    expect(page).toHaveLength(2);
    const legacy = page.find((m) => m.seq === 1);
    expect(legacy?.text).toBe("written before there were senders");
    expect(legacy?.user).toBeNull();
  });
});
