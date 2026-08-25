import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";

import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "./client";
import { migrate } from "./migrate";
import { createEnvironment, Repository } from "./repository";
import { messages } from "./schema";

// The staged failure for chapter 2.4 — offset pagination drifting under a
// moving feed.
//
// The offset read lives HERE, in the test, and not in the repository: the
// constitution says offset pagination "is not offered", and a method that
// exists is a method someone will call. Keeping the broken version in the
// suite means the demonstration stays runnable at the tag without the
// production layer ever shipping the thing the chapter argues against.
// (This file sits under src/db/ because that is where the lint rule
// permits the query engine — the same reason 2.3's DR-01 guard lives in
// repository.itest.ts.)

const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}") — never point this suite at a shared database`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let repo: Repository;

/** The pagination every framework hands you — correct for data that holds
 * still, which a chat feed never does. */
async function readByOffset(
  channelId: string,
  { offset, limit }: { offset: number; limit: number },
) {
  return db
    .select({ id: messages.id, seq: messages.sequence })
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .orderBy(desc(messages.sequence))
    .limit(limit)
    .offset(offset);
}

beforeAll(async () => {
  await migrate(pool);
  const env = await createEnvironment(db, { name: "history-drift-itest" });
  repo = new Repository(db, env.id);
});

describe("offset pagination drifts under live inserts (chapter 2.4)", () => {
  it("serves rows the reader has already seen", async () => {
    const sender = (await repo.createUser(`drift-${randomUUID().slice(0, 8)}`)).id;
    const channel = await repo.createChannel("drift-repeat", "public");
    for (let i = 1; i <= 60; i += 1) {
      await repo.sendMessage(channel.id, { text: `m-${i}`, userId: sender });
    }
    const page1 = await readByOffset(channel.id, { offset: 0, limit: 50 });
    // The feed moves mid-scroll: three drivers type while page two loads.
    for (let i = 1; i <= 3; i += 1) {
      await repo.sendMessage(channel.id, { text: `live-${i}`, userId: sender });
    }
    const page2 = await readByOffset(channel.id, { offset: 50, limit: 50 });

    const seen = new Set(page1.map((m) => m.id));
    const repeats = page2.filter((m) => seen.has(m.id));
    // Three inserts, three repeats — the drift is exactly the shift.
    expect(repeats).toHaveLength(3);
  });

  it("hides rows the reader will never see, when the feed shrinks", async () => {
    const sender = (await repo.createUser(`drift-${randomUUID().slice(0, 8)}`)).id;
    const channel = await repo.createChannel("drift-gap", "public");
    for (let i = 1; i <= 60; i += 1) {
      await repo.sendMessage(channel.id, { text: `m-${i}`, userId: sender });
    }
    const page1 = await readByOffset(channel.id, { offset: 0, limit: 50 });
    // A moderator deletes a message the reader has ALREADY passed — one
    // from page one's range. Every row below it shifts up one position,
    // so page two's offset now starts one row too late.
    const victim = page1[25]!;
    await db.execute(sql`DELETE FROM messages WHERE id = ${victim.id}`);

    const page2 = await readByOffset(channel.id, { offset: 50, limit: 50 });
    const delivered = new Set([...page1, ...page2].map((m) => m.seq));
    const survivors = await db
      .select({ seq: messages.sequence })
      .from(messages)
      .where(eq(messages.channelId, channel.id));
    const missed = survivors.filter((m) => !delivered.has(m.seq));
    // A row that still exists was served on neither page. From the
    // reader's chair that is not "a little overlap" — it is data loss.
    expect(missed.length).toBeGreaterThan(0);
  });
});
