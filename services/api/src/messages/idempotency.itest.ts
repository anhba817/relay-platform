import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  createDb,
  createPool,
  DEFAULT_DATABASE_URL,
  type Db,
} from "../db/client";
import { migrate } from "../db/migrate";
import {
  createEnvironment,
  Repository,
  type Environment,
} from "../db/repository";

// The idempotency suite (chapter 2.3): staged failure without keys,
// enforced deduplication with keys, concurrent retries, and cross-channel
// key namespacing. Requires the compose Postgres — *.itest.ts keeps it
// out of the Docker-free unit lane.

// Guardrail: integration tests run against the LOCAL compose stack only.
const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}") — never point this suite at a shared database`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let env: Environment;
let repo: Repository;
// A REAL SENDER, BECAUSE `sendMessage` REQUIRES ONE (chapter 3.17, FR-MSG-15).
//
// One row for the whole suite, created here rather than a `userId: "x"` at each call
// site. A fixture that invents an id to satisfy a compiler is a test that stopped
// meaning what it meant: this suite is about idempotency, and every message in it is
// now sent by somebody who exists.
let sender: string;

beforeAll(async () => {
  await migrate(pool);
  env = await createEnvironment(db, { name: "idempotency-itest" });
  repo = new Repository(db, env.id);
  sender = (await repo.createUser("idempotency-sender", "Idempotency Sender")).id;
});

afterAll(async () => {
  await pool.end();
});

describe("idempotency enforcement (FR-MSG-04, DR-03)", () => {
  it("a retry WITHOUT a key duplicates the message — journey 4's failure, staged", async () => {
    const channel = await repo.createChannel("idem-no-key", "public");
    await repo.sendMessage(channel.id, { userId: sender, text: "B2, north ramp" });
    // The ack was lost; the client cannot know. It retries:
    await repo.sendMessage(channel.id, { userId: sender, text: "B2, north ramp" });
    const rows = await repo.listMessagesRaw(channel.id);
    // Two rows, seq 1 and 2, identical text. The dispatcher reads it twice.
    expect(rows.filter((m) => m.text === "B2, north ramp")).toHaveLength(2);
  });

  it("a retry WITH a key returns the ORIGINAL message — the fix", async () => {
    const channel = await repo.createChannel("idem-with-key", "public");
    const key = randomUUID();
    const first = await repo.sendMessage(channel.id, { userId: sender,
      text: "B2, north ramp",
      idempotencyKey: key,
    });
    // The ack was lost; the client retries with the same key:
    const retry = await repo.sendMessage(channel.id, { userId: sender,
      text: "B2, north ramp",
      idempotencyKey: key,
    });
    // One row, ever.
    const rows = await repo.listMessagesRaw(channel.id);
    expect(rows.filter((m) => m.text === "B2, north ramp")).toHaveLength(1);
    // The retry got the ORIGINAL message back — same id, same seq.
    expect(retry.id).toBe(first.id);
    expect(retry.seq).toBe(first.seq);
    expect(retry.duplicate).toBe(true);
  });

  it("a retry returns the original's attachments and writes no second row (FR-011 (3.24))", async () => {
    const channel = await repo.createChannel("idem-attachments", "public");
    const key = randomUUID();
    const attachments = [
      { type: "url" as const, kind: "image" as const, url: "https://example.test/retry-a.png" },
      { type: "url" as const, kind: "audio" as const, url: "https://example.test/retry-b.mp3" },
    ];
    const first = await repo.sendMessage(channel.id, {
      userId: sender,
      text: "sent once",
      idempotencyKey: key,
      attachments,
    });
    const retry = await repo.sendMessage(channel.id, {
      userId: sender,
      text: "sent once",
      idempotencyKey: key,
      attachments,
    });

    expect(retry.duplicate).toBe(true);
    expect(retry.id).toBe(first.id);
    // THE RETRY BRANCH IS A DIFFERENT READ. It spreads `getMessageByIdempotencyKey`'s row
    // rather than returning the values the insert branch built, so a field carried on one
    // is not carried on the other by construction — analysis pass 9 found exactly that
    // asymmetry in the plan, and phase 3 fixed it by widening this read there.
    expect(retry.attachments.map((a) => (a.type === "url" ? a.url : "media"))).toEqual([
      "https://example.test/retry-a.png",
      "https://example.test/retry-b.mp3",
    ]);

    // AND NO SECOND ROW, READ FROM THE DATABASE rather than inferred from `duplicate`.
    // Two 201-equivalents prove nothing about what the second call DID; the row count is
    // what carries it.
    const rows = await repo.listMessagesRaw(channel.id);
    expect(rows.filter((m) => m.text === "sent once")).toHaveLength(1);
  });

  it("recovers a TOMBSTONE with an empty list and nothing published (FR-011 (3.24), FR-012 (3.24))", async () => {
    // THE CASE CHAPTER 3.18 GUARDED FOR TEXT, NOW WITH AN ATTACHMENT LIST. A message is
    // sent with a key, deleted, and the same key is retried: the idempotency index still
    // recognises it, so the retry returns the ORIGINAL row — which is now a tombstone.
    //
    // TWO THINGS FOLLOW, and both guards that carry them read `text !== null`:
    // `messages.controller.ts:234` and `session.ts:1552`. A recovered tombstone is not a
    // creation, so nothing is published; and FR-012 says its attachments are unlinked, so
    // the list comes back empty rather than as what the message once carried.
    const channel = await repo.createChannel("idem-tombstone", "public");
    const key = randomUUID();
    const first = await repo.sendMessage(channel.id, {
      userId: sender,
      text: "about to be deleted",
      idempotencyKey: key,
      attachments: [
        { type: "url", kind: "image", url: "https://example.test/doomed.png" },
      ],
    });
    await repo.deleteMessage(channel.id, first.id, { userId: sender });

    const recovered = await repo.sendMessage(channel.id, {
      userId: sender,
      text: "about to be deleted",
      idempotencyKey: key,
      attachments: [
        { type: "url", kind: "image", url: "https://example.test/doomed.png" },
      ],
    });

    expect(recovered.duplicate).toBe(true);
    expect(recovered.id).toBe(first.id);
    // A TOMBSTONE, RECOVERED. `text` is null and the attachments are gone — the retry did
    // not resurrect what the deletion unlinked.
    expect(recovered.text).toBeNull();
    expect(recovered).toHaveProperty("attachments", []);

    // AND THE GUARD'S PREMISE HOLDS: `text !== null` is false here, so both publish sites
    // skip. That is what stops a deleted message reappearing on every member's screen.
    expect(recovered.text === null).toBe(true);
  });

  it("five concurrent sends with the SAME key produce exactly one row", async () => {
    const channel = await repo.createChannel("idem-concurrent", "public");
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.sendMessage(channel.id, { userId: sender,
          text: "concurrent send",
          idempotencyKey: key,
        }),
      ),
    );
    // Exactly one row in the database.
    const rows = await repo.listMessagesRaw(channel.id);
    expect(rows.filter((m) => m.text === "concurrent send")).toHaveLength(1);
    // All five responses carry the same id and seq.
    const ids = new Set(results.map((r) => r.id));
    const seqs = new Set(results.map((r) => r.seq));
    expect(ids.size).toBe(1);
    expect(seqs.size).toBe(1);
  });

  it("a recognised duplicate consumes no sequence number", async () => {
    const channel = await repo.createChannel("idem-no-burn", "public");
    const key = randomUUID();
    await repo.sendMessage(channel.id, { userId: sender, text: "once", idempotencyKey: key });
    await repo.sendMessage(channel.id, { userId: sender, text: "once", idempotencyKey: key });
    await repo.sendMessage(channel.id, { userId: sender, text: "once", idempotencyKey: key });
    // Three sends, one row — and the NEXT message gets seq 2, not seq 4:
    // a retry that wrote nothing spends nothing (FR-MSG-02 tolerates gaps,
    // but there is no reason to manufacture them).
    const next = await repo.sendMessage(channel.id, { userId: sender, text: "after" });
    expect(next.seq).toBe(2);
  });

  it("the same key in DIFFERENT channels produces two rows — key namespace is the channel", async () => {
    const channelA = await repo.createChannel("idem-ns-a", "public");
    const channelB = await repo.createChannel("idem-ns-b", "public");
    const key = randomUUID();
    const a = await repo.sendMessage(channelA.id, { userId: sender,
      text: "same key, different channel",
      idempotencyKey: key,
    });
    const b = await repo.sendMessage(channelB.id, { userId: sender,
      text: "same key, different channel",
      idempotencyKey: key,
    });
    // Two distinct rows — the key's scope is (channel_id, key), not global.
    expect(a.id).not.toBe(b.id);
    expect(
      (await repo.listMessagesRaw(channelA.id)).filter(
        (m) => m.text === "same key, different channel",
      ),
    ).toHaveLength(1);
    expect(
      (await repo.listMessagesRaw(channelB.id)).filter(
        (m) => m.text === "same key, different channel",
      ),
    ).toHaveLength(1);
  });
});
