import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { mintUserToken } from "../auth/user-token";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-05 ON EVERY DOOR THAT SERVES A MESSAGE (US3).
//
// **THE COMPILER NAMED NONE OF THESE, WHICH IS THE POINT OF THE FILE.** 4.14 made
// `state` required so `tsc` listed every construction site; `thumbnail` is optional,
// because three cases legitimately produce no rendition, so an omission is silently
// correct and only a runtime assertion catches it. `doors.txt` records the derivation:
// four callers of `withMediaStates`, seven doors.
describe("a thumbnail reaches every door that serves a message", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  let channelId: string;
  /** THE EDIT DOOR TAKES A USER TOKEN AND NOTHING ELSE. `@Accepts("user")` on the PATCH
   * route answers 403 to an application credential — the first draft used the api key
   * for every door and read the refusal as a missing thumbnail. */
  let editorToken: string;
  const store = storeConfig();

  type Delivered = {
    type: string;
    media_id: string;
    state?: string;
    thumbnail?: { media_id: string; width: number; height: number };
  };

  const plant = async (opts: { withRendition: boolean; state?: string }) => {
    const { rows } = (await db.execute(sql`
      INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes,
                                 state, object_key, width, height)
      VALUES (gen_random_uuid(), ${env.id}, 'p.png', 'image/png', 4096,
              ${opts.state ?? "ready"}, ${env.id} || '/' || gen_random_uuid(), 1200, 900)
      RETURNING id`)) as unknown as { rows: { id: string }[] };
    const parent = rows[0]!.id;
    if (opts.withRendition) {
      await db.execute(sql`
        INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes,
                                   state, object_key, parent_id, rendition, width, height)
        VALUES (gen_random_uuid(), ${env.id}, 'thumbnail.webp', 'image/webp', 7104,
                'ready', ${env.id} || '/' || gen_random_uuid(), ${parent}, 'thumbnail',
                320, 240)`);
    }
    return parent;
  };

  const send = (mediaId: string, extra: Record<string, unknown> = {}) =>
    fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: "thumb-bot",
        text: "a photo",
        attachments: [{ type: "media", media_id: mediaId }],
        ...extra,
      }),
    });

  const attachmentsOf = (body: unknown): Delivered[] =>
    ((body as { attachments?: Delivered[] }).attachments ?? []) as Delivered[];

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "thumb-delivery-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    await repo.upsertUser("thumb-bot", {
      display_name: "Thumb Bot",
      kind: "bot",
      description: "delivers thumbnails in an integration test",
    });
    const editor = await repo.createUser("thumb-editor");
    const channel = await repo.createChannel("thumbs", "public");
    channelId = channel.id;
    await repo.addMember(channel.id, editor.id);
    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    editorToken = (
      await mintUserToken(secret, {
        user: "thumb-editor",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
      { logger: false },
    );
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("puts it on the send response", async () => {
    const parent = await plant({ withRendition: true });
    const res = await send(parent);
    expect(res.status).toBe(201);
    const [a] = attachmentsOf(await res.json());
    expect(a!.state).toBe("ready");
    expect(a!.thumbnail, "the send response carried no thumbnail").toBeDefined();
    expect(a!.thumbnail!.width).toBe(320);
    expect(a!.thumbnail!.height).toBe(240);
  });

  it("puts it in history", async () => {
    const parent = await plant({ withRendition: true });
    expect((await send(parent)).status).toBe(201);
    const res = await fetch(`${url}/v1/channels/${channelId}/messages?limit=50`, {
      headers: { authorization: `Bearer ${key.credential}` },
    });
    // `{ messages: [...] }`, not `{ data: [...] }` — the first draft guessed and got
    // `Cannot read properties of undefined (reading 'flatMap')`.
    const body = (await res.json()) as { messages: { attachments: Delivered[] }[] };
    const found = body.messages
      .flatMap((m) => m.attachments ?? [])
      .find((a) => a.media_id === parent);
    expect(found?.thumbnail, "history carried no thumbnail").toBeDefined();
  });

  it("puts it on the edit response", async () => {
    const parent = await plant({ withRendition: true });
    // Sent by the editor, because a message can only be edited by its author.
    const sent = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${editorToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: "a photo",
        attachments: [{ type: "media", media_id: parent }],
      }),
    });
    expect(sent.status).toBe(201);
    const created = (await sent.json()) as { id: string };
    const res = await fetch(`${url}/v1/channels/${channelId}/messages/${created.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${editorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "edited" }),
    });
    expect(res.status).toBe(200);
    const [a] = attachmentsOf(await res.json());
    expect(a!.thumbnail, "the edit response carried no thumbnail").toBeDefined();
  });

  it("puts it on a repeated send, which is read back rather than rebuilt", async () => {
    const parent = await plant({ withRendition: true });
    const idem = crypto.randomUUID();
    const first = await send(parent, { idempotency_key: idem });
    expect(first.status).toBe(201);
    const second = await send(parent, { idempotency_key: idem });
    // The repeat goes through `getMessageByIdempotencyKey`, a different caller of the
    // decorator from the send path — which is why it is a door of its own.
    const [a] = attachmentsOf(await second.json());
    expect(a!.thumbnail, "the idempotent repeat carried no thumbnail").toBeDefined();
  });

  // ── THE INVARIANTS (contracts/renditions.md) ────────────────────────────────────────

  it("omits the key entirely rather than sending null", async () => {
    const parent = await plant({ withRendition: false });
    const [a] = attachmentsOf(await (await send(parent)).json());
    expect(a!.state).toBe("ready");
    // `toBeUndefined` would also pass on `thumbnail: null`, so ask the object.
    expect(Object.hasOwn(a!, "thumbnail"), "an absent rendition sent a key").toBe(false);
  });

  it("offers nothing for a pending attachment, in both directions", async () => {
    const parent = await plant({ withRendition: false, state: "pending" });
    const [a] = attachmentsOf(await (await send(parent)).json());
    expect(a!.state).toBe("pending");
    expect(Object.hasOwn(a!, "thumbnail")).toBe(false);
    // Invariant 2: a thumbnail implies `ready`. The other direction — `ready` implies a
    // thumbnail — is false and must stay false, which the test above asserts.
  });

  it("does not put the thumbnail in the media.updated frame", async () => {
    // ADR-33's frame is a notification, not a payload. FR-MED-07 was amended to make the
    // event an optimisation over the floor — "a client that never receives a frame must
    // still report the right state" — so a thumbnail arriving only in the frame would
    // make the frame load-bearing. Asserted against the schema rather than a socket,
    // because the schema is what would have to change first.
    const { mediaUpdatedSchema } = await import("@relay/protocol");
    const parsed = mediaUpdatedSchema.safeParse({
      type: "media.updated",
      payload: {
        media_id: crypto.randomUUID(),
        channel: crypto.randomUUID(),
        state: "ready",
        thumbnail: { media_id: crypto.randomUUID(), width: 320, height: 240 },
      },
    });
    expect(parsed.success, "the frame accepted a thumbnail it should refuse").toBe(false);
  });
});
