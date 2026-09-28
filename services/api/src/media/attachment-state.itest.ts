import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  recordMediaVerdict,
  Repository,
} from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-07's FIRST SENTENCE, WHICH IS THE HALF THAT WORKS WITHOUT AN EVENT.
//
// The clause is two sentences and this file is about the first: every door that serves a
// message serves the attachment's CURRENT state. The second — a frame when the state
// changes — is the producer's file, and the split is deliberate rather than tidy: an
// object attached when it is already terminal has no transition left to announce, so a
// client's only correct source is the state on the attachment. **538 of the 1,589
// referenced objects on the development lane are in exactly that position.**
//
// THE VERDICT IS RECORDED DIRECTLY RATHER THAN THROUGH THE SEAM. `recordMediaVerdict` is
// what the internal route calls; driving the route instead would make every assertion
// here depend on the worker's credential and on the producer this file is defined not to
// test. What is under test is whether a READ reflects a state, not how the state arrived.
describe("an attachment is served with the state its object is in now", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  let repo: Repository;
  let channelId: string;
  const store = storeConfig();

  const slot = async (): Promise<string> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filename: "p.png", mime_type: "image/png", bytes: 1024 }),
    });
    expect(res.status, "the slot route did not issue an id to test with").toBe(201);
    return ((await res.json()) as { media_id: string }).media_id;
  };

  const send = async (mediaId: string) => {
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: "state-bot",
        text: "a photo",
        attachments: [{ type: "media", media_id: mediaId }],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return res;
  };

  const history = async (): Promise<
    { id: string; attachments: { type: string; media_id?: string; state?: string }[] }[]
  > => {
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      headers: { authorization: `Bearer ${key.credential}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { messages: never[] }).messages as never;
  };

  const stateInHistory = async (messageId: string): Promise<string | undefined> => {
    const row = (await history()).find((m) => m.id === messageId);
    expect(row, "the message this test sent is not in its own channel's history").toBeDefined();
    return row!.attachments.find((a) => a.type === "media")?.state;
  };

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "attachment-state-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    repo = new Repository(db, env.id);
    await repo.upsertUser("state-bot", {
      display_name: "State Bot",
      kind: "bot",
      description: "reads attachment states in an integration test",
    });

    const channel = await repo.createChannel("states", "public");
    channelId = channel.id;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  // T023
  it("serves `pending` for an object nothing has verified", async () => {
    const id = await slot();
    const res = await send(id);
    const { id: messageId } = (await res.json()) as { id: string };
    expect(await stateInHistory(messageId)).toBe("pending");
  });

  // T024. THE STATE IS READ WHEN THE MESSAGE IS SERVED, NOT STORED ON IT. The column is
  // asserted byte-identical either side of the verdict, which is what separates this
  // from a test that would also pass if the platform rewrote every referencing message.
  it("serves the new state after a verdict, with the message untouched", async () => {
    const id = await slot();
    const { id: messageId } = (await (await send(id)).json()) as { id: string };
    expect(await stateInHistory(messageId)).toBe("pending");

    const before = await repo.listMessagesRaw(channelId);
    const columnBefore = await db.execute(
      `select attachments::text as a from messages where id = '${messageId}'`,
    );

    const verdict = await recordMediaVerdict(db, {
      id,
      verdict: "ready",
      verifiedBytes: 1024,
      verifiedType: "image/png",
    });
    expect(verdict.applied, "the compare-and-set refused a pending object").toBe(true);

    expect(await stateInHistory(messageId)).toBe("ready");
    const columnAfter = await db.execute(
      `select attachments::text as a from messages where id = '${messageId}'`,
    );
    expect(columnAfter.rows[0]).toEqual(columnBefore.rows[0]);
    expect(before.length).toBeGreaterThan(0);
  });

  // T025
  it("carries the state on the send response, which the clause does not name", async () => {
    const id = await slot();
    const body = (await (await send(id)).json()) as {
      attachments: { type: string; state?: string }[];
    };
    expect(body.attachments.find((a) => a.type === "media")?.state).toBe("pending");
  });

  // T026 / SC-006. THE CASE NO EVENT CAN EVER SERVE. FR-MED-06 permits attaching an
  // object that is already `ready`, and for that object there is no transition left to
  // announce — so a client depending on the frame would hold a placeholder for ever.
  it("reports the right state with no transition to announce", async () => {
    const id = await slot();
    const verdict = await recordMediaVerdict(db, {
      id,
      verdict: "ready",
      verifiedBytes: 1024,
      verifiedType: "image/png",
    });
    expect(verdict.applied).toBe(true);

    const body = (await (await send(id)).json()) as {
      id: string;
      attachments: { type: string; state?: string }[];
    };
    expect(body.attachments.find((a) => a.type === "media")?.state).toBe("ready");
    expect(await stateInHistory(body.id)).toBe("ready");
  });

  // T027 / FR-MED-09. The message stays. A rejection is a record that SOMETHING was
  // sent, which Priya's reconstruction has to be able to tell from a deletion.
  it("keeps a rejected attachment's message in history, carrying `rejected`", async () => {
    const id = await slot();
    const { id: messageId } = (await (await send(id)).json()) as { id: string };
    const verdict = await recordMediaVerdict(db, {
      id,
      verdict: "rejected",
      reason: "declaration_mismatch",
    });
    expect(verdict.applied).toBe(true);
    expect(await stateInHistory(messageId)).toBe("rejected");
  });

  // T026a. Two more doors the first version of FR-003 did not name: an edit returns the
  // message it edited, and a resume replays messages a client missed — which is exactly
  // when a client is holding a stale placeholder.
  it("carries the state on the edit response and through a resume", async () => {
    const id = await slot();
    const { id: messageId } = (await (await send(id)).json()) as { id: string };
    await recordMediaVerdict(db, {
      id,
      verdict: "ready",
      verifiedBytes: 1024,
      verifiedType: "image/png",
    });

    // THE AUTHOR AS THE ROW RECORDS IT. `editMessage` compares against
    // `messages.user_id`; a bot sent this one through an API key, so the id is read
    // back rather than guessed — the fixture asks the database instead of assuming how
    // the platform resolved "state-bot".
    const author = await db.execute(
      `select user_id::text as id from messages where id = '${messageId}'`,
    );
    const edited = await repo.editMessage(channelId, messageId, {
      text: "a photo, corrected",
      userId: (author.rows[0] as { id: string }).id,
    });
    expect(edited.attachments.find((a) => a.type === "media")?.state).toBe("ready");

    const user = await repo.createUser("state-reader");
    await repo.addMember(channelId, user.id);
    const pages = await repo.backfill(user.id, { [channelId]: 0 }, 50);
    const replayed = pages[channelId]?.messages.find((m) => m.id === messageId);
    expect(replayed, "the resume did not replay the message this test sent").toBeDefined();
    expect(replayed!.attachments.find((a) => a.type === "media")?.state).toBe("ready");
  });
});
