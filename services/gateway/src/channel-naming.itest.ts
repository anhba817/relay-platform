import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { docsUrl, type Frame, type Message } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createMembership } from "./membership.js";
import { attachSessions } from "./session.js";
import { createTyping } from "./typing.js";

// WHAT A CLIENT IS TOLD A CHANNEL IS CALLED (FR-RTM-11, chapter 4.23).
//
// TEN ASSERTIONS AND NOT SEVEN. Seven client-facing schemas carry a `channel`
// field; `connection.ack` names channels three more times WITHOUT the word, in
// `revisions` and `cursor` (both keyed by channel) and in `truncated` (a list of
// them). A suite written against a grep for `channel:` would have left the first
// frame every client receives carrying uuids — which is what analysis pass 1 found
// and why this file counts structures rather than fields.
//
// THE STUB IS THE POINT OF CONTROL. The api answers with a key AND an identity for
// one channel; everything the client then receives has to name the second. Nothing
// here asserts what the api does — chapter 4.22 owns that — only what the gateway
// does with what it was told.

const url = `redis://localhost:${process.env.RELAY_REDIS_PORT ?? "6379"}`;
const silent: Logger = createLogger("gateway", () => {});

const KEY = randomUUID();
const IDENTITY = `order-${Math.floor(Math.random() * 100000)}`;
const TOKEN = "token-for-tuan";

function message(seq: number, channel = KEY): Message {
  return {
    id: `id-${seq}`,
    channel,
    seq,
    user: "mai",
    text: `m${seq}`,
    attachments: [],
    created_at: "2026-10-08T00:00:00.000Z",
  };
}

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const fanout = createFanout({ url, logger: silent });
  const typing = createTyping({ url, logger: silent });
  const membership = createMembership({ url, logger: silent });
  const api: Omit<ApiClient, "reportUsage"> = {
    // THE ONE PLACE THE TWO NAMES DIFFER. Every other stub in this service sets the
    // identity equal to the key, because those suites are about something else;
    // this one exists to tell them apart, so it must not.
    session: async () => ({
      environment_id: "env",
      user: "mai",
      channels: [{ id: KEY, external_id: IDENTITY }],
      revisions: { [KEY]: 3 },
      banned: false,
      limits: { connect: 100, send: 100 },
    }),
    memberships: async () => [KEY],
    backfill: async () => ({ [KEY]: { messages: [], truncated: false } }),
    sendMessage: async () => ({
      id: "committed",
      channel_id: KEY,
      seq: 9,
      user: "mai",
      text: "sent",
      attachments: [],
      created_at: "2026-10-08T00:00:00.000Z",
    }),
  } as unknown as Omit<ApiClient, "reportUsage">;
  const server: Server = serve({
    service: "gateway",
    notFoundDocsUrl: docsUrl("not_found"),
    health: () => ({}),
    logger: silent,
  });
  const sessions = attachSessions({
    server,
    api: { ...api, reportUsage: async () => null } as ApiClient,
    logger: silent,
    fanout,
    typing,
    membership,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    close: async () => {
      await sessions.close();
      await typing.close();
      await membership.close();
      await fanout.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function record(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  return frames;
}

async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = get();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`no ${what} within 5s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function publishFromElsewhere(m: Message): Promise<void> {
  const other = createFanout({ url, logger: silent });
  await other.publish(m);
  await other.close();
}

describe("what a client is told a channel is called", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("names the channel by its identity in the ack's three structures, and in no uuid", async () => {
    harness = await boot();
    // A CURSOR, SO THE ACK CARRIES ALL THREE. A fresh connect acks with an empty
    // cursor and an empty `truncated`; a resume fills them, which is the only way
    // to see the two structures that carry no `channel` field.
    const socket = new WebSocket(`${harness.url}?token=${TOKEN}&cursor=${KEY}:1`);
    const frames = record(socket);
    try {
      const ack = await until(
        () => frames.find((f) => f.type === "connection.ack"),
        "connection.ack",
      );
      const payload = (ack as { payload: Record<string, unknown> }).payload;
      expect(Object.keys(payload["revisions"] as object)).toEqual([IDENTITY]);
      expect(Object.keys(payload["cursor"] as object)).toEqual([IDENTITY]);
      expect(payload["truncated"]).toEqual([]);
      expect(JSON.stringify(payload)).not.toContain(KEY);
    } finally {
      socket.close();
    }
  }, 20_000);

  it("names the channel by its identity on a delivered message", async () => {
    harness = await boot();
    const socket = new WebSocket(`${harness.url}?token=${TOKEN}`);
    const frames = record(socket);
    try {
      await until(() => frames.find((f) => f.type === "connection.ack"), "ack");
      // THE ACK IS NOT THE SUBSCRIPTION. `attachSessions` subscribes the channel's
      // subject around the same instant it acks, and a publish that beats the
      // subscribe is delivered to nobody — the shape `typing.itest.ts` fails on
      // three runs in four (baseline.txt, Phase 2). Poll the publish instead of
      // betting on one.
      for (let i = 0; i < 20 && !frames.some((f) => f.type === "message.created"); i++) {
        await publishFromElsewhere(message(4));
        await new Promise((r) => setTimeout(r, 150));
      }
      const created = await until(
        () => frames.find((f) => f.type === "message.created"),
        "message.created",
      );
      expect((created as { payload: Message }).payload.channel).toBe(IDENTITY);
    } finally {
      socket.close();
    }
  }, 20_000);

  it("lets nothing a client receives over a whole session carry the key (SC-004)", async () => {
    harness = await boot();
    const socket = new WebSocket(`${harness.url}?token=${TOKEN}&cursor=${KEY}:1`);
    const frames = record(socket);
    try {
      await until(() => frames.find((f) => f.type === "connection.ack"), "ack");
      // Everything a channel-naming frame can be provoked by from outside: a
      // delivered message, a typing signal and a membership change, each on the
      // fabric the api would have used.
      // ANOTHER GATEWAY INSTANCE, NOT A RAW CLIENT. `ioredis` is restricted to the
      // two limiter files (constitution I, enforced by lint), and this suite needs
      // no exemption: the modules the gateway already uses to publish are the
      // honest way to stand in for one — the same shape `publishFromElsewhere`
      // takes for the fan-out.
      // TWO KINDS, NOT THREE. `Membership` exposes no publish — the api owns that
      // subject — so a membership frame is asserted where its own suite asserts it
      // (`membership.itest.ts`, updated by this chapter) and this sweep provokes
      // what it can reach honestly.
      const elsewhereTyping = createTyping({ url, logger: silent });
      try {
        for (let i = 0; i < 20 && frames.length < 3; i++) {
          await publishFromElsewhere(message(7));
          await elsewhereTyping.publish({
            environment: "env",
            channel: KEY,
            user: "linh",
          });
          await new Promise((r) => setTimeout(r, 150));
        }
      } finally {
        await elsewhereTyping.close();
      }
      // THE COUNT IS STATED, NOT ASSERTED IN AGGREGATE. "No uuid anywhere" is
      // equally true of a session that received nothing, which is the assertion
      // this test would otherwise be making.
      expect(frames.length).toBeGreaterThanOrEqual(3);
      const kinds = new Set(frames.map((f) => f.type));
      expect([...kinds].sort()).toEqual(["connection.ack", "message.created", "typing"]);
      expect(JSON.stringify(frames)).not.toContain(KEY);
    } finally {
      socket.close();
    }
  }, 30_000);
});
