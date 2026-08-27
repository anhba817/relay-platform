import { randomUUID } from "node:crypto";
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
// AND IT IMPORTS NOTHING AT ALL BEYOND VITEST. The socket uses Node's GLOBAL
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

describe("integrating with Relay from the outside", () => {
  let api: string;
  let ws: string;
  let credential: string;
  let channelId: string;
  let token: string;

  const post = async (path: string, body: unknown, auth: string) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
    const first = await post("/v1/channels", { external_id: external, type: "public" }, credential);
    expect(first.status).toBe(201);
    expect(first.body["external_id"]).toBe(external);
    channelId = first.body["id"] as string;

    // The documentation says a repeat returns the existing channel. 200 rather
    // than 201 is how a client tells which happened without reading the body.
    const again = await post("/v1/channels", { external_id: external, type: "public" }, credential);
    expect(again.status).toBe(200);
    expect(again.body["id"]).toBe(channelId);
  });

  it("creates a PRIVATE channel, which the route began accepting in chapter 3.15", async () => {
    // THIS TEST WAS RED FOR TWO CHAPTERS AND NOBODY SAW IT (chapter 3.17, T065).
    //
    // It asserted `400` with `field: "type"`, which was true when it was written: the
    // create route took `public` only. Chapter 3.15 (`43899e3`, "the private type decides
    // something, on every read") widened the enum to `["public","private"]` and this
    // suite was not run at that chapter's close — `pnpm test:outsider` is its own lane,
    // outside `pnpm test:integration`, so nothing in the twenty-run battery touches it.
    //
    // The one suite that stands for an external developer was wrong about the API for two
    // chapters. That is chapter 3.14's unmet half showing itself: a sealed suite proves
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
    const members = res.body["members"] as { external_id: string; status: string }[];
    expect(members.map((m) => m.external_id)).toEqual(["ana", "ben"]);
    expect(members.every((m) => m.status === "added")).toBe(true);
  });

  it("mints a token for one of those members", async () => {
    const res = await post("/auth/dev-token", { user: "ana", ttl_seconds: 3600 }, credential);
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

    const history = await fetch(`${api}/v1/channels/${channelId}/messages?limit=10`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(history.status).toBe(200);
    const page = (await history.json()) as { messages: { text: string }[] };
    expect(page.messages.map((m) => m.text)).toContain(text);
  });

  // `it.fails` UNTIL T024 BUILDS THE PUBLISH, then T023 turns it back into `it`.
  //
  // A red lane is not the same as a recorded failure. This asserts what is true
  // today — a REST send commits, answers 201, and reaches no live socket — so the
  // suite stays green while the gap stays visible. Measured when it was written:
  // 10,114 ms to the deadline, having seen only `connection.ack`.
  it.fails("receives a message on a socket — sent over REST", async () => {
    // THE SEND NO LONGER HAS TO BE ON THE SOCKET, and that is this chapter.
    //
    // The gap this exercise recorded had TWO causes. Chapter 3.17 removed the first:
    // a public send attributes a sender, so the row is no longer dropped from a
    // resume. Chapter 3.18 removes the second, which was the whole of what remained
    // — the api published to no fan-out, so a REST-sent message reached no live
    // socket. The title of this test used to say "SENT over the socket" in capitals,
    // because a REST send could not work; it now sends over REST on purpose.
    //
    // The send is the one an integrating developer's backend actually makes.
    const socket = new WebSocket(`${ws}/v1/ws?token=${token}`);
    const frames: { type: string; payload?: { text?: string; seq?: number } }[] = [];
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
      setTimeout(() => reject(new Error(`no socket at ${ws} within 10s`)), 10_000);
    });

    const waitFor = async (predicate: (f: { type: string }) => boolean, what: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await waitFor((f) => f.type === "connection.ack", "connection.ack");

    const text = `over REST ${Date.now()}`;
    // NOT `socket.send`. A POST, with the credential a customer's server holds, to
    // the route their backend calls — and then the socket is watched for the frame.
    // `user: "outside-bot"` is not optional and not decoration. Chapter 3.17 made an
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
      (f) => f.type === "message.created" && (f as { payload?: { text?: string } }).payload?.text === text,
      "message.created for the text just sent",
    );
    socket.close();
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
      expect(String(body["docs_url"])).toContain("#not_found");
      // Every error carries one, and it is what a support request quotes.
      expect(typeof body["request_id"]).toBe("string");
    }
  });
});
