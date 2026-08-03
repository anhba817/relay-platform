import { beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  await migrate(pool);
  const env = await createEnvironment(db, { name: "history-itest" });
  repo = new Repository(db, env.id);
});

async function seed(channelId: string, count: number, prefix: string) {
  for (let i = 1; i <= count; i += 1) {
    await repo.sendMessage(channelId, { text: `${prefix}-${i}` });
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
    await new Repository(db, other.id).sendMessage(theirs.id, {
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
});
