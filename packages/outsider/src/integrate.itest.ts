import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

// AN INTEGRATION BUILT FROM PUBLISHED DOCUMENTATION ALONE (FR-031, SC-009,
// SC-030).
//
// This file is the SRS Phase 2 exit criterion as a test: "an external developer
// integrates using only public documentation, with no assistance." It knows three
// things about Relay — two URLs and a credential — and everything else it does is
// HTTP and WebSocket against a running platform it did not start.
//
// IT STARTS NOTHING. No `spawn`, no compose invocation, no process launch of any
// kind. Every other integration suite in this workspace boots what it talks to,
// which is right for them and would destroy the claim here: a package that can
// start the platform is a package that knows how the platform is built. If the
// platform is absent this fails saying so, which is the correct answer.
//
// THREE MECHANICAL SEALS keep it honest, and none of them is this comment:
//
//   1. `package.json` declares no `@relay/*` dependency, and pnpm's isolated
//      `node_modules` has no `@relay` directory at the workspace root — so
//      `import { ERROR_CODES } from "@relay/protocol"` does not resolve. No rule
//      is involved; the module simply is not there.
//   2. `no-restricted-imports` in `eslint.config.mjs` refuses any specifier that
//      climbs out of this package.
//   3. `no-restricted-syntax` refuses the `".."` string literal and
//      `createRequire`, because an import rule cannot see a path built from
//      strings — `packages/e2e/src/harness.ts` builds one and spawns from it.
//
// WHAT NONE OF THE THREE CLOSES: reading the repository's source with human eyes.
// The seals make it impossible to IMPORT workspace code; they cannot make it
// impossible to look. That is a discipline, and the chapter says so rather than
// letting three rules imply a fourth (FR-034).
//
// AND IT REACHES NO WORKSPACE PATH — WHICH IS THE RULE, AND IS NOT THE SAME AS
// IMPORTING NOTHING. This sentence read *"AND IT IMPORTS NOTHING AT ALL BEYOND
// VITEST"* and was already false when it was written: line 1 is
// `import { randomUUID } from "node:crypto"`. Chapter 4.17 added `node:zlib` and made
// it falser, which is how it was noticed. **A Node builtin is not a workspace path**,
// and the three seals below say so precisely — they refuse `@relay/*`, a specifier
// that climbs out of this package, and the `".."` literal. None of them has anything
// to say about `node:`. A sentence nobody can trust is worse than no sentence, and an
// overclaiming one invites the first person who checks it to assume the seals are
// decorative too.
//
// THE SOCKET USES NODE'S GLOBAL
// `WebSocket`, not the `ws` package every suite in this workspace uses — which
// was not the plan and is the better answer. `ws` resolves from the workspace root
// by the ordinary parent walk, so the suite could have used it while declaring
// nothing; its TYPES do not, and the choice was between borrowing `@types/ws`
// through a parent walk, writing a local ambient declaration, or using the
// platform's own client. Node 22 has had a standards-compliant `WebSocket` since
// 22.4, so an outsider in 2026 needs no library — and the API is the browser's,
// which is what the series' own examples show. A dependency list that is empty
// because nothing is needed is a stronger claim than one that is empty because
// three things were reached for sideways.

const API = process.env["RELAY_API_URL"];
const WS = process.env["RELAY_WS_URL"];
const CREDENTIAL = process.env["RELAY_DEMO_CREDENTIAL"];

/** Read from the environment and checked ONCE, with a message that says what to do.
 *
 * An outsider's first failure should not be `fetch failed` against `undefined`. It
 * should be a sentence naming the three things this suite needs and where they come
 * from — which is itself part of what the exit criterion measures. */
function required(): { api: string; ws: string; credential: string } {
  const missing = [
    API ? null : "RELAY_API_URL",
    WS ? null : "RELAY_WS_URL",
    CREDENTIAL ? null : "RELAY_DEMO_CREDENTIAL",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `this suite integrates against a RUNNING platform and starts nothing. ` +
        `Missing: ${missing.join(", ")}. Bring the platform up and seed a tenant:\n` +
        `  RELAY_POSTGRES_PORT=15432 docker compose up -d --wait\n` +
        `  DATABASE_URL=postgres://relay:relay@localhost:15432/relay node services/api/dist/db/migrate.js\n` +
        `  RELAY_POSTGRES_PORT=15432 docker compose --profile services up -d --wait\n` +
        `  export RELAY_DEMO_CREDENTIAL=$(node scripts/seed-demo-tenant.mjs)\n` +
        `  export RELAY_API_URL=http://localhost:4000 RELAY_WS_URL=ws://localhost:4001`,
    );
  }
  return { api: API!, ws: WS!, credential: CREDENTIAL! };
}

/** An 800 × 600 greyscale PNG, built here because it cannot be a literal (chapter 4.17).
 *
 * **IT HAS TO EXCEED 320 px ON ITS LONG EDGE OR THERE IS NO THUMBNAIL TO FETCH.** The
 * worker's `thumbnailOf` answers `within-bound` at or below the bound and writes no
 * rendition at all (chapter 4.15), so the 1×1 literal this file already carries would
 * make the journey assert a rendition id the history payload never contains — and the
 * assertion would fail naming the id rather than the bound.
 *
 * AND AT THAT SIZE A LITERAL IS NOT AVAILABLE: the pixels deflate to 480,756 bytes.
 * `node:zlib` is a Node builtin, not a workspace path, so building it here breaks no
 * seal — see the header, whose claim to import nothing was corrected in the same
 * chapter.
 *
 * NOISE FROM A FIXED SEED, WHICH IS TWO PROPERTIES AND BOTH ARE WANTED. Deterministic,
 * so the file is the same 480,813 bytes on every machine and `bytes` can be declared
 * against it — FR-MED-03 refuses a declaration that is one byte out, in either
 * direction (chapter 4.13). And incompressible, so the size is a fact about the
 * dimensions rather than about the picture, which is what keeps the thumbnail
 * comparison meaningful: a photograph of a white wall would thumbnail LARGER than the
 * parent and the assertion would read as a defect.
 *
 * GREYSCALE RATHER THAN RGB for the reason a fixture should be cheap: one byte a pixel
 * is a third of the store, a third of the quota the slot reserves and a third of the
 * PUT. */
const journeyPng = (): Uint8Array<ArrayBuffer> => {
  const width = 800;
  const height = 600;

  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    // THE CRC COVERS THE TYPE AND THE DATA, NOT THE LENGTH. A PNG with the length
    // included decodes in nothing, and `sharp` would answer `rendition_failed` — which
    // the journey would read as the worker being broken.
    const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    out.writeUInt32BE(crc >>> 0, data.length + 8);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0, greyscale

  // XORSHIFT32, NOT A LINEAR CONGRUENTIAL GENERATOR. The obvious
  // `seed = (seed * 1103515245 + 12345) >>> 0` loses its low bits to floating point —
  // the product passes 2^53 — and the sequence degenerates: the same 800 × 600 image
  // built that way deflated to **23,284 bytes**, a 62× ratio that says the "noise" was
  // structure. The byte count is the tell, and it is the reason this fixture is
  // measured rather than assumed.
  const raw = Buffer.alloc(height * (1 + width));
  let seed = 1;
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width);
    raw[row] = 0; // filter type 0, None — one byte before every scanline
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      raw[row + 1 + x] = seed & 0xff;
    }
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};

describe("integrating with Relay from the outside", () => {
  let api: string;
  let ws: string;
  let credential: string;
  let channelId: string;
  let token: string;

  const post = async (path: string, body: unknown, auth: string) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };

  /** The read twin of `post`, added by chapter 4.12 for the delivery route. Eleven
   *  tests reached the api through `post` alone and the two that needed a GET built
   *  their own `fetch`; a third would have been the point at which the shape was a
   *  convention nobody had written down. */
  const get = async (path: string, auth: string) => {
    const res = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };

  /** Wait for a media attachment to leave `pending`, by reading the channel the way a
   *  client would (chapter 4.17).
   *
   *  **THERE IS NO SURFACE THAT ANSWERS "HAS THE WORKER RUN YET".** The client PUTs
   *  straight to the store (ADR-13), so nothing tells the platform the upload finished
   *  and chapter 4.13 built a sweep on a 5,000 ms timer instead. A client learns the
   *  verdict by reading the message again, which is what this does.
   *
   *  A CONDITION WITH A DEADLINE, NEVER AN ELAPSED TIME. The wait is uniform over the
   *  interval — measured at min 1,861, p50 3,993, max 5,568 ms over ten independent
   *  trials — so an assertion on duration would be tuned to whichever point in the cycle
   *  the test happened to start at. An earlier measurement of this platform reported
   *  `p50 5,693 ms` from five runs taken in a loop, each beginning just after the sweep
   *  that ended the one before: **a loop that waits for the thing it is timing
   *  synchronises with it.**
   *
   *  AND THE FAILURE NAMES THE WORKER, because from out here it has to. With the worker
   *  stopped an uploaded object stays `pending` for ever and `GET /v1/media/{id}` answers
   *  the same 404 as an id nobody has — chapter 4.12 built that indistinguishability
   *  deliberately — so a deadline that reported only "still pending" would describe a
   *  legitimate state and say nothing about why. */
  const waitForAttachmentState = async (
    channelId: string,
    mediaId: string,
    auth: string,
    deadlineMs = 25_000,
  ): Promise<string> => {
    // NO `let seen = "pending"` BEFORE THE LOOP — the initialiser is never read, and
    // `no-useless-assignment` says so. Chapter 4.16 hit the identical rule on a
    // `let seen = 0`; this is the second time, which makes it a habit rather than a slip.
    const started = Date.now();
    for (;;) {
      const res = await get(
        `/v1/channels/${channelId}/messages?limit=10`,
        auth,
      );
      const messages = (res.body["messages"] ?? []) as {
        attachments?: { media_id?: string; state?: string }[];
      }[];
      const attachment = messages
        .flatMap((m) => m.attachments ?? [])
        .find((a) => a.media_id === mediaId);
      const seen = attachment?.state ?? "absent";
      if (seen !== "pending") return seen;
      if (Date.now() - started > deadlineMs) {
        throw new Error(
          `media ${mediaId} is still '${seen}' after ${Date.now() - started} ms. ` +
            `The sweep runs every 5,000 ms, so this is not the timer — the media worker ` +
            `is not producing verdicts. Check that it is running and that its boot line ` +
            `names a reachable scanner: 'docker compose logs media-worker | tail -2'.`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(() => {
    ({ api, ws, credential } = required());
  });

  it("reaches the platform at all", async () => {
    // Before anything else, and separately, so a platform that is not there says
    // so once instead of failing eight times with eight different messages.
    const res = await fetch(`${api}/healthz`);
    expect(res.status, `no healthy api at ${api}`).toBe(200);
  });

  it("creates a channel, and creating it twice is not an error", async () => {
    const external = `outsider-${Date.now()}`;
    const first = await post(
      "/v1/channels",
      { external_id: external, type: "public" },
      credential,
    );
    expect(first.status).toBe(201);
    expect(first.body["external_id"]).toBe(external);
    channelId = first.body["id"] as string;

    // The documentation says a repeat returns the existing channel. 200 rather
    // than 201 is how a client tells which happened without reading the body.
    const again = await post(
      "/v1/channels",
      { external_id: external, type: "public" },
      credential,
    );
    expect(again.status).toBe(200);
    expect(again.body["id"]).toBe(channelId);
  });

  it("creates a PRIVATE channel, which the route began accepting in the channel-control chapter", async () => {
    // THIS TEST WAS RED FOR TWO CHAPTERS AND NOBODY SAW IT (T065).
    //
    // It asserted `400` with `field: "type"`, which was true when it was written: the
    // create route took `public` only. The channel-control chapter (`43899e3`, "the private type decides
    // something, on every read") widened the enum to `["public","private"]` and this
    // suite was not run at that chapter's close — `pnpm test:outsider` is its own lane,
    // outside `pnpm test:integration`, so nothing in the twenty-run battery touches it.
    //
    // The one suite that stands for an external developer was wrong about the API for two
    // chapters. That is the outsider milestone's unmet half showing itself: a sealed suite proves
    // nothing about the documentation if nobody runs it.
    const res = await post(
      "/v1/channels",
      { external_id: `outsider-private-${Date.now()}`, type: "private" },
      credential,
    );
    expect(res.status).toBe(201);
    expect(res.body["type"]).toBe("private");
  });

  it("adds two members, creating the users on first membership", async () => {
    const res = await post(
      `/v1/channels/${channelId}/members`,
      { user_ids: ["ana", "ben"] },
      credential,
    );
    expect(res.status).toBe(200);
    const members = res.body["members"] as {
      external_id: string;
      status: string;
    }[];
    expect(members.map((m) => m.external_id)).toEqual(["ana", "ben"]);
    expect(members.every((m) => m.status === "added")).toBe(true);
  });

  it("mints a token for one of those members", async () => {
    const res = await post(
      "/auth/dev-token",
      { user: "ana", ttl_seconds: 3600 },
      credential,
    );
    expect(res.status).toBe(200);
    token = res.body["token"] as string;
    expect(typeof token).toBe("string");
  });

  it("creates a bot, because a key send must name one", async () => {
    // FOLLOWED FROM THE README, which says an application key carries no user of its own
    // and may name only a bot — and that `kind` and `description` travel together. This
    // suite is sealed from workspace code, so what it knows is what the documentation
    // says.
    const res = await post(
      "/v1/users",
      {
        users: [
          {
            external_id: "outside-bot",
            display_name: "Outside Bot",
            kind: "bot",
            description: "the outsider's own software, posting from a script",
          },
        ],
      },
      credential,
    );
    expect(res.status).toBe(200);
    const data = res.body["data"] as {
      external_id: string;
      kind: string;
      description: string;
    }[];
    expect(data[0]).toMatchObject({
      external_id: "outside-bot",
      kind: "bot",
      description: "the outsider's own software, posting from a script",
    });
  });

  it("refuses a send that names nobody, and says which field", async () => {
    // The refusal an integrator meets first if they skip the step above. Worth asserting
    // from out here: a 400 that did not name the field would leave a developer guessing,
    // and the README promises this one.
    const res = await post(
      `/v1/channels/${channelId}/messages`,
      { text: "who is this from?" },
      credential,
    );
    expect(res.status).toBe(400);
    expect(res.body["field"]).toBe("user");
  });

  it("refuses a send that names a person, with its own code", async () => {
    // "ana" was created by the member-add above, so she is a PERSON. A key may not post
    // as her — and the code is specific rather than a generic 403, which is what tells an
    // integrator to create a bot instead of to go looking for a permission.
    const res = await post(
      `/v1/channels/${channelId}/messages`,
      { text: "posting as a human", user: "ana" },
      credential,
    );
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("sender_not_permitted");
  });

  it("sends a message over REST and reads it back from history", async () => {
    const text = `from the outside ${Date.now()}`;
    const sent = await post(
      `/v1/channels/${channelId}/messages`,
      { text, user: "outside-bot" },
      credential,
    );
    expect(sent.status).toBe(201);
    // The response echoes the sender it recorded, which the README promises.
    expect(sent.body["user"]).toBe("outside-bot");

    const history = await fetch(
      `${api}/v1/channels/${channelId}/messages?limit=10`,
      {
        headers: { authorization: `Bearer ${credential}` },
      },
    );
    expect(history.status).toBe(200);
    const page = (await history.json()) as { messages: { text: string }[] };
    expect(page.messages.map((m) => m.text)).toContain(text);
  });

  // WAS `it.fails` FOR THE LENGTH OF THIS CHAPTER'S PHASE 1 AND 2.
  //
  // A red lane is not the same as a recorded failure, so the gap was asserted
  // rather than left broken: 10,114 ms to the deadline having seen only
  // `connection.ack`, with a 201 in hand. The publish landed in Phase 3 and this
  // became a plain `it` — the body now succeeds in about 150 ms.
  it("receives a message on a socket — sent over REST", async () => {
    // THE SEND NO LONGER HAS TO BE ON THE SOCKET, and that is this chapter.
    //
    // The gap this exercise recorded had TWO causes. The sender chapter removed the first:
    // a public send attributes a sender, so the row is no longer dropped from a
    // resume. The fan-out chapter removes the second, which was the whole of what remained
    // — the api published to no fan-out, so a REST-sent message reached no live
    // socket. The title of this test used to say "SENT over the socket" in capitals,
    // because a REST send could not work; it now sends over REST on purpose.
    //
    // The send is the one an integrating developer's backend actually makes.
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: {
      type: string;
      payload?: { text?: string; seq?: number };
    }[] = [];
    // Listeners attached BEFORE the open await. `connection.ack` arrives the
    // instant the upgrade completes, and awaiting `open` first yields to the event
    // loop — the frame lands with no listener and is gone.
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("close", (event) =>
        reject(new Error(`closed ${(event as CloseEvent).code}`)),
      );
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    const waitFor = async (
      predicate: (f: { type: string }) => boolean,
      what: string,
    ) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await waitFor((f) => f.type === "connection.ack", "connection.ack");

    const text = `over REST ${Date.now()}`;
    // NOT `socket.send`. A POST, with the credential a customer's server holds, to
    // the route their backend calls — and then the socket is watched for the frame.
    // `user: "outside-bot"` is not optional and not decoration. The sender chapter made an
    // application credential speak only as a bot user of its tenant, so a POST without
    // it is a 400 naming `user` — which is how the first run of this inverted test
    // failed, for a reason that had nothing to do with delivery.
    const posted = await post(
      `/v1/channels/${channelId}/messages`,
      // A UUID, because the REST body demands one: `idempotency_key: z.string().uuid()`
      // on this route, where the socket frame's `idem_key` is any string up to 255.
      // Two entrances, two idempotency contracts — the second run of this inverted
      // test failed on it, with `invalid_request` naming the field.
      { text, user: "outside-bot", idempotency_key: randomUUID() },
      credential,
    );
    expect(posted.status).toBe(201);

    // The REST response is the acknowledgement — there is no `message.ack` frame on
    // this path, because the sender is not holding a socket. What has to arrive is
    // the delivery, on a socket that was already open before the send.
    await waitFor(
      (f) =>
        f.type === "message.created" &&
        (f as { payload?: { text?: string } }).payload?.text === text,
      "message.created for the text just sent",
    );
    socket.close();
  });

  /** T033. ATTACHMENTS THROUGH THE SHIPPED BINARY.
   *
   * This file is the only instrument in the repository that boots what customers run and
   * drives it the way they do — Node's global `WebSocket`, no workspace import, the REST
   * credential a customer's server holds. The revisions chapter's plan scheduled a title audit
   * over this file and no task wrote to it; this chapter writes.
   *
   * TWO ATTACHMENTS AND THE ORDER, for the reason every other test in this chapter gives:
   * one cannot show an order, and FR-006 says order holds on every path that returns a
   * message. */
  it("delivers two attachments to a socket, in order, sent over REST", async () => {
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: {
      type: string;
      payload?: { text?: string; attachments?: { url?: string }[] };
    }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("close", (event) =>
        reject(new Error(`closed ${(event as CloseEvent).code}`)),
      );
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    const waitFor = async (
      predicate: (f: { type: string }) => boolean,
      what: string,
    ) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor((f) => f.type === "connection.ack", "connection.ack");

    const text = `with pictures ${Date.now()}`;
    const posted = await post(
      `/v1/channels/${channelId}/messages`,
      {
        text,
        user: "outside-bot",
        idempotency_key: randomUUID(),
        attachments: [
          {
            type: "url",
            kind: "image",
            url: "https://example.test/outside-first.png",
          },
          {
            type: "url",
            kind: "video",
            url: "https://example.test/outside-second.mp4",
          },
        ],
      },
      credential,
    );
    expect(posted.status).toBe(201);

    const delivered = (await waitFor(
      (f) =>
        f.type === "message.created" &&
        (f as { payload?: { text?: string } }).payload?.text === text,
      "message.created carrying the attachments",
    )) as { payload: { attachments: { url?: string }[] } };
    expect(delivered.payload.attachments.map((a) => a.url)).toEqual([
      "https://example.test/outside-first.png",
      "https://example.test/outside-second.mp4",
    ]);
    socket.close();
  });

  /** T032e. **HOSTED MEDIA, FROM OUTSIDE, WITH NOTHING BUT A PUBLISHED CREDENTIAL.**
   *
   * The test above delivers two attachments and types its frames
   * `attachments?: { url?: string }[]` — the old assumption written into a type, on the
   * one instrument in this repository that boots what customers run. A chapter whose
   * headline claim is that a second arm now works end to end, and which left this suite
   * url-only, would have proven the claim everywhere except where it is worth proving.
   *
   * THE WHOLE SEQUENCE IS PUBLISHED SURFACE: `POST /v1/media` for a slot, a `PUT` to the
   * URL that comes back, `POST …/messages` naming the id, and a socket that was open
   * before any of it. No workspace import, no internal route, no fixture reaching into
   * Postgres — the same constraint every other test in this file holds itself to.
   *
   * AND THE PUT GOES WHERE THE API SIGNED. The upload URL names an origin this process
   * must be able to reach, which is a property of the deployment and not of the client:
   * the host is inside the SigV4 signature, so a URL signed for the compose network
   * would be unusable from here. That is what `RELAY_MINIO_INTERNAL_ENDPOINT` exists to
   * keep apart, and this test is the only thing outside the api that would notice. */
  it("uploads a file and attaches it, from outside, in order beside a url (FR-021, SC-002d)", async () => {
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: {
      type: string;
      payload?: { text?: string; attachments?: unknown[] };
    }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("close", (event) =>
        reject(new Error(`closed ${(event as CloseEvent).code}`)),
      );
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    const waitFor = async (
      predicate: (f: { type: string }) => boolean,
      what: string,
    ): Promise<{ type: string; payload?: { attachments?: unknown[] } }> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    // A REAL PNG, AND THE OLD FIXTURE IS WHY IT HAD TO BECOME ONE.
    //
    // This uploaded `[137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]` — the PNG signature plus
    // three zeros, with no `IHDR` — and declared 11 bytes for it. **The size was right
    // and the bytes were not a PNG**, which was invisible until the platform grew
    // something that reads them: the slot route records *"what the caller said, not what
    // arrived"*. Under FR-MED-03 that object is `rejected` and never delivers.
    //
    // BUILT FROM BYTES RATHER THAN IMPORTED. This package declares no `@relay/*`
    // dependency and no workspace path may be reached from here, so the fixture is a
    // literal — which is also the honest shape for a suite claiming to know nothing
    // about how the platform is built. A 1×1 greyscale PNG with a stored (uncompressed)
    // deflate block, 67 bytes.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b, 0x55, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00,
      0x02, 0x00, 0x01, 0x48, 0xaf, 0xa4, 0x71, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const slot = await post(
      "/v1/media",
      { filename: "outside.png", mime_type: "image/png", bytes: png.length },
      credential,
    );
    expect(
      slot.status,
      "the platform refused a slot to a published credential",
    ).toBe(201);
    const mediaId = slot.body["media_id"] as string;

    // THE BYTES GO STRAIGHT TO THE STORE AND NOT THROUGH RELAY, which is ADR-13's whole
    // claim and is invisible from in-workspace tests that never leave the process.
    const uploaded = await fetch(slot.body["upload_url"] as string, {
      method: "PUT",
      body: png,
    });
    expect(
      uploaded.status,
      "the presigned URL was not usable from outside",
    ).toBe(200);

    const text = `outside media ${randomUUID()}`;
    const posted = await post(
      `/v1/channels/${channelId}/messages`,
      {
        text,
        user: "outside-bot",
        idempotency_key: randomUUID(),
        attachments: [
          {
            type: "url",
            kind: "image",
            url: "https://example.test/outside-url.png",
          },
          { type: "media", media_id: mediaId },
        ],
      },
      credential,
    );
    expect(posted.status).toBe(201);

    const delivered = (await waitFor(
      (f) =>
        f.type === "message.created" &&
        (f as { payload?: { text?: string } }).payload?.text === text,
      "message.created carrying a hosted attachment",
    )) as { payload: { attachments: unknown[] } };

    // BOTH ARMS, IN ORDER, ON THE SOCKET. The url arm proves nothing new; what it does is
    // hold the order claim, which one attachment cannot show.
    //
    // AND THE MEDIA ARM CARRIES ITS STATE SINCE CHAPTER 4.14 — **the fifth assertion of
    // this shape and the only one no local lane reaches.** `pnpm test`,
    // `pnpm test:integration` and `pnpm coverage` all skip this suite: it needs a
    // composed stack and three environment variables, so CI's sealed job and a
    // hand-run are the only things that execute it. The other four were found by the
    // api lane and the coverage lane; this one was found by CI.
    //
    // `pending` IS RIGHT, AND THE REASON WRITTEN HERE WAS FALSE FOR TWO CHAPTERS.
    //
    // It read: *"this suite runs no media worker, which is what makes the value stable
    // rather than timing-dependent."* **CI's sealed job runs
    // `docker compose --profile services up -d --wait`, and `media-worker` is in that
    // profile** — so a worker has been running every time this assertion passed.
    //
    // It is timing-dependent AND it is stable, which are two different claims. The sweep
    // runs every 5,000 ms and the three steps between the PUT and this line take
    // milliseconds, so the margin is most of an interval: measured at min 1,861, p50
    // 3,993, max 5,568 ms from PUT to verdict over ten independent trials. **A race with
    // a four-second margin is the kind nothing ever catches**, and the sentence that
    // would have explained it away is the one chapter 4.17 went looking for.
    expect(delivered.payload.attachments).toEqual([
      {
        type: "url",
        kind: "image",
        url: "https://example.test/outside-url.png",
      },
      { type: "media", media_id: mediaId, state: "pending" },
    ]);
    socket.close();

    // AND THE REASON IS NOW CHECKED RATHER THAN ASSERTED IN PROSE (chapter 4.17). A
    // comment is not a test: if the state above is `pending` because the read is inside
    // the window, then waiting past the window must produce a verdict. If a future
    // change stops a worker running in this lane, the line above keeps passing and this
    // one goes red naming the worker.
    const settled = await waitForAttachmentState(
      channelId,
      mediaId,
      credential,
    );
    expect(settled, "the deployed worker produced no verdict").toBe("ready");

    // AND THE BYTES COME BACK, FROM OUTSIDE (chapter 4.12, SC-010). The frame above
    // carries an id and nothing else; a client holding it has to ask for a URL, and
    // this is the only test in the repository that asks as a customer does — over the
    // published surface, from a process that started nothing, through a URL whose host
    // was chosen by the api and has to be reachable from here.
    //
    // THAT LAST PART IS THE PROPERTY WORTH HAVING. `RELAY_MINIO_INTERNAL_ENDPOINT`
    // exists because the host is inside the SigV4 signature, so the address the api
    // probes the store on and the address it signs for a client cannot be one field. A
    // delivery URL signed with the internal one is refused rather than slow, and nothing
    // inside the workspace would notice.
    // AND IT IS A POLL NOW, BECAUSE ADR-14's GATE PUT A PROCESS BETWEEN THE UPLOAD AND
    // THE LINK. *"No signed URL until `ready`"*, and the only thing that produces `ready`
    // is the media worker — so this assertion stopped being about the delivery route
    // alone and became the one test in the repository that exercises upload, sweep,
    // scan, verdict and delivery end to end, from outside. **That is a real cost of the
    // gate** and it is the one the packaging decision was made with in front of it: the
    // unpackaged shape the ingester has would have made this unsatisfiable.
    //
    // THE DEADLINE IS THE SWEEP INTERVAL PLUS THE WORK. Measured at five-second polling:
    // p50 5,080 ms from upload to `ready`, of which 7 ms is the work. Thirty seconds is
    // six intervals, so a failure here means the worker is not running rather than that
    // it was slow.
    const deadline = Date.now() + 30_000;
    let link = await get(`/v1/media/${mediaId}`, credential);
    while (link.status === 404 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      link = await get(`/v1/media/${mediaId}`, credential);
    }
    expect(
      link.status,
      "the platform refused a delivery URL for its own attachment",
    ).toBe(200);
    expect(typeof link.body["expires_at"]).toBe("string");

    const bytes = await fetch(link.body["url"] as string);
    expect(bytes.status, "the delivery URL was not usable from outside").toBe(
      200,
    );
    // AGAINST THE SAME ARRAY THAT WAS UPLOADED, not a second copy of it. This read
    // `new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0])` — the old fixture,
    // written out twice — and when the upload became a real PNG the assertion kept
    // comparing against eleven bytes that were no longer sent anywhere.
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);
  });

  /** **★ THE MILESTONE: ONE IMAGE, END TO END, THROUGH THE WORKER A DEPLOYMENT RUNS**
   *  (chapter 4.17 — FR-001, FR-002, FR-004a, FR-006a, SC-001, SC-002, SC-003, SC-003a).
   *
   *  Seven chapters built this path one piece at a time and **no test joined them.** The
   *  pieces each have a suite: 4.13's worker verifies in process, 4.14's state machine is
   *  driven by SQL, 4.15's thumbnail is a unit test over a buffer, 4.12's delivery gate
   *  sets its states by hand. Every one of them stands in for the step beside it. This is
   *  the only check in the repository where **nothing stands in for anything** — the
   *  verdict is made by the container `docker compose --profile services` starts, and the
   *  suite learns it the way a customer would, by reading the message again.
   *
   *  EACH STEP NAMES THE CHAPTER THAT MADE IT POSSIBLE (FR-002). That is not decoration:
   *  this test crosses seven chapters and three services, so a failure here is a question
   *  about which of them moved. A bare `expected 404 to be 200` at step eight sends a
   *  reader to the delivery route, which is the one part of the path that is almost never
   *  the cause.
   *
   *  ITS OWN CHANNEL, AND NOT THE SHARED ONE. `channelId` has collected messages from
   *  eleven tests by the time this runs, so a history read against it would have to
   *  search rather than assert — and a journey that searches cannot claim the recipient
   *  sees one message with one attachment.
   *
   *  AND IT CALLS NO INTERNAL ROUTE. `POST /internal/media/{id}/verdict` would make every
   *  assertion below pass in forty milliseconds, and it is the thing this chapter exists
   *  to stop doing: a test that calls the verdict route is a test of the api's reaction
   *  to a verdict, which 4.14 already has. */
  it("carries one image from slot to delivered bytes, with the deployed worker making the verdict (4.17, SC-001)", async () => {
    // STEP 1 — A CHANNEL OF ITS OWN, AND A MEMBER IN IT (chapters 2.2 and 3.8).
    //
    // THE MEMBERSHIP IS NOT OPTIONAL AND ITS ABSENCE IS SILENT. Measured while this was
    // being written: a socket opened with a valid token for a non-member received
    // `connection.ack` and `presence.changed` and **no `message.created` and no
    // `media.updated`** — on a PUBLIC channel. The absence of every frame looks exactly
    // like the absence of the one you came for, which is how an earlier probe read as
    // `media.updated` not existing at all.
    const journeyChannel = await post(
      "/v1/channels",
      { external_id: `journey-${Date.now()}`, type: "public" },
      credential,
    );
    expect(
      journeyChannel.status,
      "the journey could not create its own channel",
    ).toBe(201);
    const journeyId = journeyChannel.body["id"] as string;

    const member = await post(
      `/v1/channels/${journeyId}/members`,
      { user_ids: ["ana"] },
      credential,
    );
    expect(
      member.status,
      "chapter 3.8's members route refused ana, so her socket will hear nothing",
    ).toBe(200);

    // STEP 2 — A SOCKET OPEN BEFORE ANY OF IT (chapter 3.4).
    //
    // Before the send, deliberately. A subscriber who connects afterwards learns the
    // state from history and tells us nothing about the frame; the claim FR-006a makes
    // is that a client holding a placeholder is TOLD when it becomes a picture.
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: { type: string; payload?: Record<string, unknown> }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("close", (event) =>
        reject(new Error(`closed ${(event as CloseEvent).code}`)),
      );
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    const until = async (
      predicate: (f: {
        type: string;
        payload?: Record<string, unknown>;
      }) => boolean,
      what: string,
    ): Promise<{ type: string; payload?: Record<string, unknown> }> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until((f) => f.type === "connection.ack", "ana's connection.ack");

    // STEP 3 — A SLOT FOR A REAL IMAGE (chapter 4.10).
    //
    // `bytes` is DECLARED and the store counts what arrives. FR-MED-03 refuses a
    // mismatch of one byte in either direction (chapter 4.13), which is why the fixture
    // is deterministic and its length is read rather than written down.
    const image = journeyPng();
    expect(
      image.length,
      "the fixture moved; the figures in the chapter are measured",
    ).toBe(480_813);

    const slot = await post(
      "/v1/media",
      { filename: "journey.png", mime_type: "image/png", bytes: image.length },
      credential,
    );
    expect(
      slot.status,
      "chapter 4.10's slot route refused a published credential",
    ).toBe(201);
    expect(
      slot.body["state"],
      "a slot is pending before anything is uploaded",
    ).toBe("pending");
    const journeyMediaId = slot.body["media_id"] as string;

    // STEP 4 — THE BYTES GO TO THE STORE, NOT THROUGH RELAY (ADR-13, chapter 4.10).
    const put = await fetch(slot.body["upload_url"] as string, {
      method: "PUT",
      body: image,
    });
    expect(put.status, "the presigned URL was not usable from outside").toBe(
      200,
    );

    // STEP 5 — THE SEND HAPPENS BEFORE THE VERDICT, ON PURPOSE (chapter 4.11).
    //
    // FR-MED-06's decision: a photo may be attached the moment the upload completes,
    // because the alternative is a client that has to wait on a timer it cannot see.
    // So the recipient's first sight of this message is a placeholder, and that is the
    // state being asserted — not a race this test happens to win.
    const journeyText = `journey ${randomUUID()}`;
    const sent = await post(
      `/v1/channels/${journeyId}/messages`,
      {
        text: journeyText,
        user: "outside-bot",
        idempotency_key: randomUUID(),
        attachments: [{ type: "media", media_id: journeyMediaId }],
      },
      credential,
    );
    expect(
      sent.status,
      "chapter 4.11's reference check refused an object this tenant owns",
    ).toBe(201);
    expect(sent.body["attachments"]).toEqual([
      { type: "media", media_id: journeyMediaId, state: "pending" },
    ]);

    // And the recipient sees the placeholder too (chapter 3.4, chapter 4.14).
    const created = await until(
      (f) =>
        f.type === "message.created" && f.payload?.["text"] === journeyText,
      "message.created for the journey's message",
    );
    expect(created.payload?.["attachments"]).toEqual([
      { type: "media", media_id: journeyMediaId, state: "pending" },
    ]);

    // STEP 6 — THE DEPLOYED WORKER DECIDES (chapters 4.13 and 4.14).
    //
    // Nothing is called here. The sweep runs on its own 5,000 ms timer inside a
    // container this process did not start, HEADs the object, scans the bytes, checks
    // them against what was declared, and writes a verdict. A condition with a
    // deadline, never an elapsed time.
    const state = await waitForAttachmentState(
      journeyId,
      journeyMediaId,
      credential,
    );
    expect(
      state,
      "the deployed worker produced no verdict for a valid PNG",
    ).toBe("ready");

    // STEP 7 — AND THE CLIENT IS TOLD (chapter 4.14, FR-006a, SC-003a).
    //
    // The frame carries `{media_id, channel, state}` and no thumbnail, so a client
    // learns THAT the placeholder resolved from the socket and WHAT it resolved to from
    // history. That split is the gateway's: `announce` returns early unless the state is
    // `ready` or `rejected`, so the two terminal states travel the same way.
    const updated = await until(
      (f) =>
        f.type === "media.updated" &&
        f.payload?.["media_id"] === journeyMediaId,
      "media.updated for the journey's attachment",
    );
    //
    // THE WHOLE PAYLOAD, NOT THE STATE ALONE. `{media_id, channel, state}` and nothing
    // else — asserting only the state would pass for a frame announcing somebody else's
    // object in somebody else's channel, which is the shape a fan-out bug takes. The
    // channel is the id rather than the external id, which is worth pinning from out
    // here because it is the field a client routes on.
    expect(updated.payload).toEqual({
      media_id: journeyMediaId,
      channel: journeyId,
      state: "ready",
    });

    // STEP 8 — WHAT A RECIPIENT ACTUALLY READS (chapters 4.14 and 4.15).
    //
    // The whole payload, not the state alone: the rendition's id and its dimensions
    // travel beside it, so a client never has to guess what to ask for. 320 × 240 is
    // 4.15's bound applied to an 800 × 600 parent — the long edge lands ON the bound and
    // the aspect ratio is kept.
    //
    // `messages`, NOT `data`. A defaulting accessor over the wrong key turned this into
    // what looked like history dropping the attachment (research R7).
    const history = await get(
      `/v1/channels/${journeyId}/messages?limit=10`,
      credential,
    );
    expect(history.status).toBe(200);
    const read = (
      history.body["messages"] as { text?: string; attachments?: unknown[] }[]
    ).find((m) => m.text === journeyText);
    expect(read?.attachments).toEqual([
      {
        type: "media",
        media_id: journeyMediaId,
        state: "ready",
        thumbnail: { media_id: expect.any(String), width: 320, height: 240 },
      },
    ]);
    const thumbnailId = (
      read?.attachments as { thumbnail: { media_id: string } }[]
    )[0]!.thumbnail.media_id;

    // STEP 9 — THE BYTES COME BACK, AND THEY ARE THE BYTES (chapter 4.12).
    //
    // BYTE-IDENTICAL, NOT THE SAME LENGTH. A length check passes for a file the store
    // truncated, for a file served from the wrong key at the same size, and for a
    // thumbnail that happens to match.
    const parentLink = await get(`/v1/media/${journeyMediaId}`, credential);
    expect(
      parentLink.status,
      "chapter 4.12's gate refused a ready object in a visible channel",
    ).toBe(200);
    const parentBytes = await fetch(parentLink.body["url"] as string);
    expect(
      parentBytes.status,
      "the delivery URL was not usable from outside",
    ).toBe(200);
    expect(new Uint8Array(await parentBytes.arrayBuffer())).toEqual(image);

    // STEP 10 — AND THE THUMBNAIL, WHICH NO MESSAGE NAMES (chapter 4.15).
    //
    // **THE ONLY MEDIA ID THE PLATFORM HANDS OUT THAT NO MESSAGE REFERENCES.** 4.12's
    // authorisation asks which channels reference the object, and the answer for a
    // rendition is none — so it would be readable by nobody if the rule were applied to
    // it directly. `readableMediaObjectKey` resolves `parentId ?? mediaId`, which is
    // what makes this request answerable at all, and this is the first time anything
    // outside the platform has asked it.
    const thumbLink = await get(`/v1/media/${thumbnailId}`, credential);
    expect(
      thumbLink.status,
      "a rendition inherits its parent's reachability (4.15)",
    ).toBe(200);
    const thumbBytes = await fetch(thumbLink.body["url"] as string);
    expect(thumbBytes.status).toBe(200);
    const thumb = new Uint8Array(await thumbBytes.arrayBuffer());

    // TWO SIGNED URLS THAT BOTH ANSWER 200 PROVE NOTHING IF THEY SERVE THE SAME OBJECT,
    // and `parentId ?? mediaId` is exactly the shape that would quietly return the
    // parent for both. Smaller AND different, because either alone can be satisfied by
    // the wrong answer: a truncated parent is smaller, and a second copy of the parent
    // is different from nothing at all.
    expect(
      thumb.length,
      "the thumbnail is not smaller than its parent",
    ).toBeLessThan(image.length);
    expect(thumb).not.toEqual(image);

    socket.close();

    // WHAT THIS TEST DOES NOT ASSERT, AND WHY IT IS NOT AN OVERSIGHT: how long any of it
    // took. The verdict arrives somewhere inside a 5,000 ms window whose phase this
    // process does not control, so an elapsed-time assertion would be tuned to whichever
    // point in the sweep the run happened to start at — which is how an earlier
    // measurement of this platform came back with a p50 of 5,693 ms, a figure that was
    // the worst case wearing a median's name. **The lane checks the condition and the
    // chapter publishes the distribution.**
  });

  /** **THE OTHER HALF: A REFUSAL ARRIVES AS A MARKER, NOT A GAP** (chapter 4.17 —
   *  FR-003, FR-006a, SC-004, SC-003a).
   *
   *  FR-MED-09's reason is a person: a recipient must be able to tell *"somebody sent me
   *  a file and the platform refused it"* from *"somebody deleted a message"* and from
   *  *"somebody sent text"*. Those are three different things to say back, and before
   *  this test nothing checked they are three different things to READ.
   *
   *  THE BYTES CONTRADICT THE DECLARATION, WHICH IS FR-MED-03 AND NOT THE SCANNER. A
   *  43-byte GIF89a declared as `image/png`: the slot route records what the caller said
   *  and the worker reads what arrived (chapter 4.13). **No object can both satisfy
   *  `ALLOWED_TYPES` and trip the virus scanner** — there is no text type in the table,
   *  so EICAR cannot be uploaded as anything — which is why the refusal this journey can
   *  actually produce is the type one.
   *
   *  AND THE DECLARED SIZE IS HONEST. 43 bytes declared, 43 uploaded; a mismatch of one
   *  byte in either direction is a different refusal, and a test that got both wrong at
   *  once would pass for the wrong reason. */
  it("delivers a refused upload as a rejected marker a recipient can tell apart (4.17, SC-004)", async () => {
    const rejectChannel = await post(
      "/v1/channels",
      { external_id: `reject-${Date.now()}`, type: "public" },
      credential,
    );
    expect(rejectChannel.status).toBe(201);
    const rejectId = rejectChannel.body["id"] as string;
    expect(
      (
        await post(
          `/v1/channels/${rejectId}/members`,
          { user_ids: ["ana"] },
          credential,
        )
      ).status,
      "ana was not added, so her socket will hear nothing",
    ).toBe(200);

    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: { type: string; payload?: Record<string, unknown> }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    // NOTHING IS SWALLOWED IN THIS TEST. An earlier probe of this path wrapped its setup
    // in `.catch(() => {})`, so a members call with the wrong body failed silently and
    // the subscriber stayed outside the channel — it then saw NO frames at all, and
    // "no `media.updated`" read exactly like the feature not existing. Three of four
    // attempts at this probe failed that way.
    socket.addEventListener("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("close", (event) =>
        reject(new Error(`closed ${(event as CloseEvent).code}`)),
      );
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    // A REAL GIF89a, 1 × 1, 43 bytes — a file that is valid and is not what was claimed.
    // Random bytes would be refused too, by `rendition_failed` or by the sniff finding
    // nothing; a well-formed file of the wrong type is the case the clause describes.
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00,
      0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);

    const slot = await post(
      "/v1/media",
      { filename: "liar.png", mime_type: "image/png", bytes: gif.length },
      credential,
    );
    // Chapter 4.10's slot route judges the DECLARATION; chapter 4.13's worker judges the
    // bytes. That split is why a lying upload is accepted here and refused later.
    expect(
      slot.status,
      "chapter 4.10's slot route judges the declaration, not the bytes",
    ).toBe(201);
    const rejectedId = slot.body["media_id"] as string;
    expect(
      (
        await fetch(slot.body["upload_url"] as string, {
          method: "PUT",
          body: gif,
        })
      ).status,
      "chapter 4.10's presigned PUT refused bytes the store should have taken",
    ).toBe(200);

    const rejectText = `rejected journey ${randomUUID()}`;
    const sent = await post(
      `/v1/channels/${rejectId}/messages`,
      {
        text: rejectText,
        user: "outside-bot",
        idempotency_key: randomUUID(),
        attachments: [{ type: "media", media_id: rejectedId }],
      },
      credential,
    );
    expect(
      sent.status,
      "chapter 4.11's reference check refused a send that happens before the verdict",
    ).toBe(201);

    const state = await waitForAttachmentState(
      rejectId,
      rejectedId,
      credential,
    );
    expect(
      state,
      "chapter 4.13's worker accepted a GIF declared as a PNG (FR-MED-03)",
    ).toBe("rejected");

    // THE FRAME CARRIES THE REFUSAL TOO (FR-006a, SC-003a). `announce` returns early
    // unless the state is `ready` or `rejected`, so both terminal states travel the same
    // way — and until this test the rejection half had only ever been watched with
    // `recordMediaVerdict` called directly by a test (chapter 4.14).
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (frames.some((f) => f.type === "media.updated")) break;
      if (Date.now() > deadline) {
        throw new Error(
          `no media.updated after a rejection; saw ${frames.map((f) => f.type).join(", ")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(frames.find((f) => f.type === "media.updated")?.payload).toEqual({
      media_id: rejectedId,
      channel: rejectId,
      state: "rejected",
    });
    socket.close();

    // FR-MED-09's TESTABLE HALF: THE MESSAGE SURVIVES THE REFUSAL. Checked as a premise
    // before it was asserted — a history route that filtered a message whose only
    // attachment was refused would make this whole user story unbuildable, and the
    // chapter would have had to record that rather than work round it. It does not
    // filter.
    const history = await get(
      `/v1/channels/${rejectId}/messages?limit=10`,
      credential,
    );
    const read = (
      history.body["messages"] as {
        text?: string | null;
        attachments?: unknown[];
      }[]
    ).find((m) => m.text === rejectText);
    expect(
      read,
      "the message vanished from history when its attachment was refused",
    ).toBeDefined();
    expect(read?.attachments).toEqual([
      { type: "media", media_id: rejectedId, state: "rejected" },
    ]);

    // AND THREE CASES A RECIPIENT MUST TELL APART, FROM PUBLISHED FIELDS ALONE. This is
    // the clause's own reason rather than a shape test:
    //
    //   a refused upload      text: the sender's   attachments: [{… state:"rejected"}]
    //   a message with none   text: the sender's   attachments: []
    //   a deleted message     text: NULL           attachments: []
    //
    // The tombstone is what makes the third distinguishable, and it is a different field
    // from the one carrying the second — so a client that reads only `attachments`
    // cannot tell a deletion from a plain message, and one that reads only `text` cannot
    // tell a refusal from a delivery.
    const plain = await post(
      `/v1/channels/${rejectId}/messages`,
      {
        text: `plain ${randomUUID()}`,
        user: "outside-bot",
        idempotency_key: randomUUID(),
      },
      credential,
    );
    // Chapter 3.18 is where a message gained an `attachments` array at all, so an empty
    // one is that chapter's answer for "nothing attached" rather than an absent field.
    expect(plain.status).toBe(201);
    expect(
      plain.body["attachments"],
      "chapter 3.18's empty array became something else",
    ).toEqual([]);

    const doomed = await post(
      `/v1/channels/${rejectId}/messages`,
      {
        text: `doomed ${randomUUID()}`,
        user: "outside-bot",
        idempotency_key: randomUUID(),
      },
      credential,
    );
    expect(doomed.status, "chapter 3.18's send refused a plain message").toBe(
      201,
    );
    const removed = await fetch(
      `${api}/v1/channels/${rejectId}/messages/${doomed.body["id"] as string}`,
      { method: "DELETE", headers: { authorization: `Bearer ${credential}` } },
    );
    expect(
      removed.status,
      "chapter 3.17's delete refused its own message",
    ).toBe(204);

    const after = await get(
      `/v1/channels/${rejectId}/messages?limit=10`,
      credential,
    );
    const tombstone = (
      after.body["messages"] as {
        id: string;
        text?: string | null;
        attachments?: unknown[];
      }[]
    ).find((m) => m.id === (doomed.body["id"] as string));
    expect(
      tombstone?.text,
      "chapter 3.17's tombstone keeps the row and loses the text, and this did not",
    ).toBeNull();
    expect(
      tombstone?.attachments,
      "chapter 3.17's tombstone left attachments behind",
    ).toEqual([]);

    // AND THE LINK IS REFUSED, INDISTINGUISHABLY FROM AN ID NOBODY HAS (chapter 4.12).
    //
    // Byte-identical apart from `request_id`, which is the property 4.12 built on
    // purpose: a refusal naming the cause would report whether somebody else's object
    // exists. **This is the first time it has been checked from outside with a real
    // refusal behind it** — every earlier check set the state with SQL, so the two sides
    // of the comparison were both fixtures.
    const refused = await get(`/v1/media/${rejectedId}`, credential);
    const ghost = await get(`/v1/media/${randomUUID()}`, credential);
    expect(refused.status).toBe(404);
    expect(ghost.status).toBe(404);
    // FILTERED RATHER THAN DESTRUCTURED. `const { request_id: _ignored, ...rest }` is
    // the idiomatic spelling and `no-unused-vars` refuses it here, underscore and all.
    const withoutRequestId = (body: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "request_id"),
      );
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(ghost.body),
    );
    // AND THE CONTROL, BECAUSE TWO EMPTY OBJECTS ARE ALSO EQUAL. The comparison above is
    // worth nothing unless the bodies have content, and a refusal that dropped its code
    // would satisfy it. Both fields are chapter 3.26's envelope.
    expect(
      refused.body["code"],
      "chapter 3.26's error envelope lost its code",
    ).toBe("not_found");
    expect(
      refused.body["request_id"],
      "chapter 3.26's request_id is the one field that must differ",
    ).not.toBe(ghost.body["request_id"]);
  });

  /** T100a — **the first `socket.send` in this file's history.**
   *
   * `grep -c "\.send(" packages/outsider/src/integrate.itest.ts` read **0** across
   * eleven tests before this one: ten REST, and one socket test whose title says
   * "sent over REST" because the fan-out chapter corrected it. This file is the only
   * check in the repository that uses the public surface as a customer does —
   * Node's global `WebSocket`, no workspace import — and until now it had never
   * exercised the inbound seam at all.
   *
   * That matters for this chapter in particular: **every other check on the
   * inbound frame is in-workspace, using the `ws` package this file refuses to
   * import.** A protocol a customer cannot drive is a protocol nobody has tested
   * from outside. */
  it("says it is typing, and a second member's socket hears it", async () => {
    const second = await post(
      "/auth/dev-token",
      { user: "ben", ttl_seconds: 3600 },
      credential,
    );
    expect(second.status).toBe(200);
    const benToken = second.body["token"] as string;

    const open = async (
      forToken: string,
    ): Promise<{
      socket: WebSocket;
      frames: { type: string; payload?: { channel?: string; user?: string } }[];
    }> => {
      const socket = new WebSocket(`${ws}/v1/ws?token=${forToken}`);
      const frames: {
        type: string;
        payload?: { channel?: string; user?: string };
      }[] = [];
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)) as { type: string });
      });
      socket.addEventListener("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        setTimeout(
          () => reject(new Error(`no socket at ${ws} within 10s`)),
          10_000,
        );
      });
      return { socket, frames };
    };

    const until = async (
      frames: { type: string; payload?: { channel?: string; user?: string } }[],
      predicate: (f: {
        type: string;
        payload?: { channel?: string; user?: string };
      }) => boolean,
      what: string,
    ): Promise<void> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (frames.some(predicate)) return;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const ana = await open(token);
    const ben = await open(benToken);
    await until(ana.frames, (f) => f.type === "connection.ack", "ana's ack");
    await until(ben.frames, (f) => f.type === "connection.ack", "ben's ack");

    ana.socket.send(
      JSON.stringify({ type: "typing.send", payload: { channel: channelId } }),
    );

    await until(
      ben.frames,
      (f) =>
        f.type === "typing" &&
        f.payload?.channel === channelId &&
        f.payload?.user === "ana",
      "a typing frame naming ana",
    );
    // And the signaller hears nothing of their own — checked here rather than only
    // in-workspace, because it is the half a customer would notice.
    expect(ana.frames.filter((f) => f.type === "typing")).toEqual([]);

    ana.socket.close();
    ben.socket.close();
  });

  /** T100b — the refusal, from outside.
   *
   * `docs/08-error-reference.md` tells a customer *"send `message.send` … Do not
   * send events; receive them."* **Nothing had ever checked what happens when they
   * do.** This is that correction in bytes rather than in prose. */
  it("holds five connections and is refused a sixth with 4004 (FR-RTM-09)", async () => {
    // T048. **THE ONLY INSTRUMENT THAT BOOTS THE SHIPPED BINARY**,
    // and the reason this task is a plan requirement rather than a polish item.
    //
    // The typing chapter built a module, awaited its `close()` so lint saw a used
    // variable, and never passed it to `attachSessions`. The feature was inert in
    // the product while 1,174 coverage tests and 174 gateway integration tests
    // were green — `**/main.ts` is excluded from the ratchet, so no number could
    // have shown it — and this file is what found it. A chapter that adds an
    // argument to `attachSessions` owes a test here.
    //
    // Nothing in this file is stubbed: the api and the gateway are the built
    // artifacts, the token came from the real dev-token endpoint, and the socket
    // is a browser `WebSocket`.
    const sockets: WebSocket[] = [];
    const openOne = async (): Promise<WebSocket> => {
      const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
      sockets.push(socket);
      socket.addEventListener("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("close", (event) =>
          reject(new Error(`closed ${(event as CloseEvent).code}`)),
        );
        setTimeout(
          () => reject(new Error(`no socket at ${ws} within 10s`)),
          10_000,
        );
      });
      return socket;
    };

    try {
      for (let i = 0; i < 5; i += 1) await openOne();

      const sixth = new WebSocket(`${ws}/v1/ws?token=${token}`);
      sockets.push(sixth);
      const frames: { type: string; payload?: { code?: string } }[] = [];
      sixth.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)) as { type: string });
      });
      sixth.addEventListener("error", () => undefined);
      const code = await new Promise<number>((resolve, reject) => {
        sixth.addEventListener("close", (event) =>
          resolve((event as CloseEvent).code),
        );
        setTimeout(
          () => reject(new Error("the sixth was not closed within 10s")),
          10_000,
        );
      });

      // The code a client branches on, and the frame that carries the detail.
      expect(code).toBe(4004);
      expect(frames.find((f) => f.type === "error")?.payload?.code).toBe(
        "connection_limit_reached",
      );
    } finally {
      for (const socket of sockets) socket.close();
    }
  }, 60_000);

  it("is refused with unknown_frame_type for a frame only the server may send", async () => {
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: { type: string; payload?: { code?: string } }[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) =>
        resolve((event as CloseEvent).code),
      );
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      setTimeout(
        () => reject(new Error(`no socket at ${ws} within 10s`)),
        10_000,
      );
    });

    // `message.ack` is the server's word. A client sending it is claiming to be the
    // server, which is a protocol violation rather than a malformed frame.
    socket.send(JSON.stringify({ type: "message.ack", payload: { seq: 1 } }));

    const deadline = Date.now() + 10_000;
    for (;;) {
      const error = frames.find((f) => f.type === "error");
      if (error) {
        expect(error.payload?.code).toBe("unknown_frame_type");
        break;
      }
      if (Date.now() > deadline) throw new Error("no error frame within 10s");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await closed).toBe(4002);
  });

  /** An edit, over the shipped binary, seen on somebody else's socket.
   *
   * **WRITTEN BECAUSE THIS FILE IS THE ONLY THING THAT BOOTS THE PRODUCT.** CLAUDE.md
   * records what that bought: the typing chapter built a module, awaited its `close()`, never
   * passed it to `attachSessions`, and shipped it inert past 1,174 coverage tests and
   * 174 gateway integration tests. This file found it. The rule it left behind — a
   * chapter that adds an argument to `attachSessions` owes an outsider test — applies
   * here for the same reason one level out: the revisions chapter adds a second Redis subject, a second
   * callback on the fan-out and a second frame kind, and every in-workspace test of
   * that path uses a stub fan-out or the `ws` package this file refuses to import.
   *
   * **NO TASK CREATED THIS TEST.** T090 lists this file among "eleven files this
   * chapter adds tests to" and nothing in the plan added one; the audit task was
   * scheduled over work no task did. `baseline.txt` records it.
   *
   * What it proves that nothing else does: the api's `publishRevision` reaches a real
   * Redis, on the subject ADR-24 took, and a real gateway process routes it by prefix
   * to a real socket as `message.updated` — not as `message.created`, which is the
   * failure the whole ADR exists to prevent and which no shape check can see, because
   * the updated arm's payload IS a `Message`. */
  it("edits a message over REST, and a member's socket hears message.updated exactly once, with no second creation", async () => {
    const minted = await post(
      "/auth/dev-token",
      { user: "watcher", ttl_seconds: 3600 },
      credential,
    );
    expect(minted.status).toBe(200);
    const token = minted.body["token"] as string;
    // The watcher has to be a member to be delivered to — the channel is public, so
    // this is about subscription rather than permission.
    const joined = await post(
      `/v1/channels/${channelId}/members`,
      // `user_ids`, and it takes a LIST. The first draft posted `{ user: "watcher" }`
      // and got a 400 — `addMembersBodySchema` is a `strictObject` over
      // `user_ids: [...]`, and the entry may be a bare identifier or an object with a
      // role. An outsider test guessing a body shape is the whole reason this file
      // exists; two earlier tests in it were written twice for the same reason.
      { user_ids: ["watcher"] },
      credential,
    );
    expect([200, 201]).toContain(joined.status);

    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> =
      [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string });
    });
    socket.addEventListener("error", () => undefined);
    const waitFor = async (
      predicate: (f: {
        type: string;
        payload?: Record<string, unknown>;
      }) => boolean,
      what: string,
    ) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor((f) => f.type === "connection.ack", "connection.ack");

    // SENT BY THE WATCHER'S OWN TOKEN, because only an author may edit (FR-013) and
    // the edit route accepts no application credential at all (FR-013a). So the send
    // uses the token too — a POST with a user token is attributed to its subject and
    // must not name a `user` in the body.
    const before = `outsider edit ${Date.now()}`;
    const posted = await fetch(`${api}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: before }),
    });
    expect(posted.status).toBe(201);
    const sent = (await posted.json()) as { id: string; seq: number };
    await waitFor(
      (f) => f.type === "message.created" && f.payload?.["text"] === before,
      "message.created for the text just sent",
    );

    const after = `${before} (corrected)`;
    const edited = await fetch(
      `${api}/v1/channels/${channelId}/messages/${sent.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: after }),
      },
    );
    expect(edited.status).toBe(200);

    const frame = await waitFor(
      (f) => f.type === "message.updated" && f.payload?.["text"] === after,
      "message.updated for the corrected text",
    );
    // THE SEQUENCE IS THE ONE IT HAD (FR-002), on the wire and not only in the row.
    expect(frame.payload?.["seq"]).toBe(sent.seq);
    expect(frame.payload?.["id"]).toBe(sent.id);
    // AND NO SECOND CREATION. This is the assertion ADR-24 is for: route the revision
    // to the old callback and the edit arrives as `message.created`, indistinguishable
    // from a new message to every client. Counting is what sees it — a `waitFor` that
    // resolves on the first match cannot.
    expect(frames.filter((f) => f.type === "message.created")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "message.updated")).toHaveLength(1);
    socket.close();
  });

  /** THE REQUEST LOG (FR-ANL-07), AND WHAT AN OUTSIDER ACTUALLY FINDS THERE.
   *
   * By the time this runs the suite has made a dozen calls with this credential —
   * channels, members, tokens, sends, a history read. So the log should not be empty, and
   * **it is.** The platform ships no ingester: `compose.yaml` starts the stores, the api
   * and the gateway, and nothing drains the analytics stream into ClickHouse. The records
   * are published and they wait.
   *
   * THAT IS THE ASSERTION RATHER THAN A REASON TO OMIT THE ROUTE. A customer's-eye test
   * showing an empty log because the platform ships no ingester is the freshness gap
   * arriving where a customer would actually meet it — and it asserts something true,
   * where skipping the endpoint asserts nothing at all. When an ingester ships, this test
   * goes red and the line below is where the number goes.
   *
   * WHAT IS ASSERTED REGARDLESS: the envelope is the documented one, and the refusals
   * work. Those do not depend on a row existing. */
  it("serves a request log with the documented envelope, and every row is this tenant's", async () => {
    const res = await fetch(`${api}/v1/request-log`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body["requests"])).toBe(true);
    expect(typeof body["has_more"]).toBe("boolean");
    expect(body["window"]).toBeTruthy();
    expect(typeof body["retention_edge"]).toBe("string");
    // `next_cursor` and `prev_cursor` are DECLARED and null at the ends, which is a
    // different fact from being absent — a client that reads `next_cursor` off this
    // response gets null rather than undefined.
    expect(body).toHaveProperty("next_cursor");
    expect(body).toHaveProperty("prev_cursor");

    // THIS ASSERTED AN EMPTY LIST UNTIL CHAPTER 4.9, AND THE EMPTINESS WAS THE DEFECT.
    //
    // Chapter 4.8 wrote it that way and said so in as many words: every request above is
    // made with this credential and every one of them is recorded — to a stream nothing
    // read. `compose.yaml` ships no ingester, so the records accumulated and the customer's
    // own log stayed empty. An assertion that a defect is still present is an honest
    // assertion and a fragile one: **it fails the moment somebody fixes the defect.**
    //
    // Chapter 4.9 did, partly. `request-log.itest.ts` now starts an ingester for its own
    // duration, and the first run of it drained a 1,038-record backlog that had been sitting
    // on the stream since 4.4 — this tenant's rows among them. So the log is no longer empty
    // on a lane where that suite has run, and it still is on one where it has not.
    //
    // **The assertion is now about the property the clause actually asks for**: whatever is
    // in this page belongs to the tenant whose credential fetched it (FR-ANL-07, and
    // constitution I). That holds in both states, which is what makes it worth asserting.
    //
    // AND `endpoint` IS NULLABLE, WHICH THIS ASSERTION DENIED UNTIL CHAPTER 4.12. It read
    // `typeof row["endpoint"]` must be `"string"`, and chapter 4.8 had already measured
    // the opposite on the platform's own data: NULL on 31 real rows — 23 rate-limited and
    // 8 unmatched — because a request the router never matched has no route to name. That
    // chapter built the reader to answer `null` rather than the `\N` ClickHouse writes,
    // and wrote two tests for it. The seal here went on asserting a string.
    //
    // It survived because this suite's rows are the ones this suite made, and every one of
    // them matches a route. What exposed it was 4.12 measuring the malformed-path-param
    // class against this same tenant: `GET /v1/channels/not-a-uuid/members` is an
    // unmatched route, so the demo tenant's log gained a row with no endpoint and the seal
    // went red for a fact the platform publishes.
    const requests = body["requests"] as Array<Record<string, unknown>>;
    for (const row of requests) {
      expect(["string", "object"]).toContain(typeof row["endpoint"]);
      if (row["endpoint"] !== null)
        expect(typeof row["endpoint"]).toBe("string");
      expect(typeof row["status"]).toBe("number");
      expect(typeof row["request_id"]).toBe("string");
    }
    // AND THE PAGE FLAG AGREES WITH THE PAGE. `has_more` is false for a page below the
    // limit, whatever the count — which is the half a bare `toEqual([])` could never check.
    if (requests.length < 50) expect(body["has_more"]).toBe(false);
  });

  it("refuses a page size outside the published bound, and says which field", async () => {
    const res = await fetch(`${api}/v1/request-log?limit=201`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["field"]).toBe("limit");
    expect(typeof body["code"]).toBe("string");
    expect(typeof body["docs_url"]).toBe("string");
    expect(typeof body["request_id"]).toBe("string");
  });

  it("cannot see another tenant's channel, and cannot tell it apart from an absent one", async () => {
    // The documented isolation property, exercised the only way an outsider can:
    // with an id that is well formed and is not theirs. The reference says both
    // answer identically, so this checks that rather than taking it on faith.
    const nowhere = "00000000-0000-4000-8000-000000000000";
    const a = await fetch(`${api}/v1/channels/${nowhere}/messages`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const b = await fetch(`${api}/v1/webhooks/${nowhere}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    for (const res of [a, b]) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("not_found");
      // AN ANCHOR ON ONE PAGE, AND THIS LINE SAID THE OPPOSITE FOR A PART AND A HALF.
      //
      // It read `toContain("/not_found")` — a path per code — under a comment ending
      // *"Asserted as this platform actually answers."* It was not: `docsUrl` returns
      // `${base}#${code}`, and the commit that made it an anchor landed BEFORE this
      // suite was written. So the suite has never passed, and nothing said so, because
      // it needs a running platform that no lane starts. Chapter 4.8 found it by
      // standing the stack up to run its own new test in this file.
      //
      // The platform is right and the test was wrong: `docs/08-error-reference.md` is
      // ONE page with a section per code, so a path per code would 404 for every
      // refusal this platform sends.
      expect(String(body["docs_url"])).toContain("#not_found");
      // Every error carries one, and it is what a support request quotes.
      expect(typeof body["request_id"]).toBe("string");
    }
  });
});
