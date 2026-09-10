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

  it("refuses a private channel, naming the field", async () => {
    // Documented behaviour, not a guess: the reference says `type` accepts
    // `public` and the error names the offending key. An integration that reads
    // the reference should be able to rely on both.
    const res = await post(
      "/v1/channels",
      { external_id: `outsider-private-${Date.now()}`, type: "private" },
      credential,
    );
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("invalid_request");
    expect(res.body["field"]).toBe("type");
    // And the docs_url is a URL, with the code as its fragment.
    expect(String(res.body["docs_url"])).toContain("#invalid_request");
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

  it("sends a message over REST and reads it back from history", async () => {
    const text = `from the outside ${Date.now()}`;
    const sent = await post(`/v1/channels/${channelId}/messages`, { text }, credential);
    expect(sent.status).toBe(201);

    const history = await fetch(`${api}/v1/channels/${channelId}/messages?limit=10`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(history.status).toBe(200);
    const page = (await history.json()) as { messages: { text: string }[] };
    expect(page.messages.map((m) => m.text)).toContain(text);
  });

  it("receives a message on a socket — SENT over the socket", async () => {
    // THE SEND HAS TO BE ON THE SOCKET, and finding that out is one of the gaps
    // this exercise recorded. A message sent over `POST /v1/channels/:id/messages`
    // reaches no socket at all: the api publishes to no fan-out, and the public
    // send attributes no user, so the row is dropped from resume for having no
    // sender. Nothing in the published documentation said so.
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

    const text = `over the socket ${Date.now()}`;
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: `outsider-${Date.now()}`, channel: channelId, text },
      }),
    );

    // The sender's own acknowledgement, then the event. Both are documented and
    // both matter: the ack says it was committed, the event says it was delivered.
    await waitFor((f) => f.type === "message.ack", "message.ack");
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
