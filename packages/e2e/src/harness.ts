import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import type { Frame, Message } from "@relay/protocol";

// The system harness (chapter 2.8): boots the api and N gateway instances as
// CHILD PROCESSES against the compose stores, wires a minimal client per
// persona, and — the part that matters — can kill a socket at a precise
// moment mid-conversation.
//
// Child processes, not in-process servers, for one reason: journey 4's star
// stage is a TRANSPORT death, and the whole point of the milestone is that
// nothing in the path is a fake. Two gateways here are two operating-system
// processes with their own ports, their own Redis connections and their own
// registries — the configuration 2.6 proved a single-instance test cannot
// see past.
//
// The client is deliberately primitive: connect, send, collect frames,
// remember the highest seq applied per channel, hold unacked sends with
// their keys. That is the SDK's job description (Part 5) played by a few
// dozen lines of test code — and when the real SDK exists, its own e2e
// reuses this exact scenario.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

/** Store coordinates are FORWARDED, never invented. Each service already has
 * a default (2.1's `DEFAULT_DATABASE_URL`, 2.6's `DEFAULT_REDIS_URL`), and a
 * harness that composes its own URL from a port variable becomes a second
 * source of truth — one that can hand a child process an address the parent
 * would never have used itself. That is precisely how this suite first
 * failed: turbo runs tasks in strict env mode, the port variable was
 * filtered out, and the harness confidently passed `localhost:5432` to an
 * api that would have found the right store on its own. */
const forwarded = (...names: string[]): Record<string, string> =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

/** DECISION (chapter 2.8): the suite seeds through the api's own repository
 * layer, imported from its build output. There is no admin API to create an
 * environment, a user or a channel yet — that is Part 3's tenancy work — and
 * inventing one for a test would be inventing product. The import is a
 * test-only seam with a named retirement, like 2.3's `listMessagesRaw`.
 *
 * REASSESSED IN CHAPTER 3.12 (T063a), and two of the three now have an API.
 * `POST /v1/channels` and `POST /v1/channels/:channelId/members` are public, and
 * the members route creates a user on first membership — so `createChannel`,
 * `createUser` and `addMember` could all come off this seam today. The list it
 * still NEEDS is shorter than the list it uses:
 *
 *   still needed   createEnvironment   no admin API, and none is planned before
 *                                      the dashboard
 *                  createApiKey        the same, and for the same chapter
 *                  sendMessage         only to write an UNATTRIBUTED row, which
 *                                      is what `journey 4` needs a foreign tenant
 *                                      to hold; the public send writes exactly
 *                                      that, so this one is convenience rather
 *                                      than necessity
 *   no longer       createChannel      POST /v1/channels
 *                  createUser         created on first membership
 *                  addMember          POST /v1/channels/:channelId/members
 *
 * NOT MIGRATED HERE, and the reason is the one this chapter keeps running into:
 * `packages/e2e` is excluded from the coverage run by name, so moving its seeding
 * to public HTTP would prove nothing the branch figures can see, and it would
 * rewrite four journeys in a chapter about isolation. `services/gateway/src/
 * public-surface.itest.ts` makes the same claim where the coverage run does look,
 * and `packages/outsider` makes the stronger one in a package that cannot import
 * this file at all. The migration is chapter 3.15's, with the rest of FR-CHN. */
interface Seeder {
  createEnvironment: (
    db: unknown,
    input: { name: string },
  ) => Promise<{ id: string }>;
  /** Chapter 3.2: the suite needs a real credential now, and it mints one the
   * same way signup does. There is still no admin API for keys — that is the
   * dashboard's chapter — so this stays a test-only seam with a named
   * retirement, exactly like the rest of this interface. */
  createApiKey: (
    db: unknown,
    input: { environmentId: string; name?: string },
  ) => Promise<{ credential: string }>;
  Repository: new (
    db: unknown,
    environmentId: string,
  ) => {
    createUser: (
      externalId: string,
      displayName?: string,
    ) => Promise<{ id: string }>;
    createChannel: (
      externalId: string,
      type: "public" | "private",
      name?: string,
    ) => Promise<{ id: string }>;
    addMember: (channelId: string, userId: string) => Promise<boolean>;
    sendMessage: (
      channelId: string,
      body: { text: string; userId?: string },
    ) => Promise<{ id: string; seq: number }>;
  };
}

function loadApiInternals(): {
  db: unknown;
  seeder: Seeder;
} {
  const dist = join(REPO, "services", "api", "dist", "db");
  if (!existsSync(join(dist, "repository.js"))) {
    throw new Error(
      "the api is not built — run `pnpm build` before the e2e lane " +
        "(the suite boots the real service, not a stub)",
    );
  }
  const client = require_(join(dist, "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "repository.js")) as Seeder;
  return { db: client.createDb(client.createPool()), seeder };
}

async function waitForHealth(url: string, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${what} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One persona's client: a socket, a frame log, and a cursor. */
export class Client {
  private socket: WebSocket | undefined;
  readonly frames: Frame[] = [];
  /** Highest sequence APPLIED per channel — the client's half of resume
   * (2.7), and the reason a resumed session gets no duplicates. */
  readonly cursors = new Map<string, number>();
  /** Sends that were written but never acked. The queue survives a socket
   * death, which is what makes 2.3's key worth minting before the send. */
  readonly unacked: { text: string; channel: string; key: string }[] = [];

  constructor(
    readonly name: string,
    private readonly token: string,
    private readonly log: (line: string) => void,
  ) {}

  async connect(gatewayUrl: string, resume = false): Promise<void> {
    // Frames from the previous connection stay in the log — this client is
    // the same client, the way an SDK is the same object across a reconnect
    // — so waits must look only at what arrives from here on.
    const from = this.frames.length;
    const cursor = resume
      ? [...this.cursors]
          .map(([channel, seq]) => `&cursor=${channel}:${seq}`)
          .join("")
      : "";
    const url = `${gatewayUrl}/v1/ws?token=${this.token}${cursor}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      this.frames.push(frame);
      if (frame.type === "message.created") {
        const { channel, seq } = frame.payload;
        this.cursors.set(
          channel,
          Math.max(this.cursors.get(channel) ?? 0, seq),
        );
      }
      if (frame.type === "message.ack") {
        // An ack clears the oldest unacked send: this client has one in
        // flight at a time, which is all the journey needs.
        this.unacked.shift();
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await this.waitFor(
      (f) => f.type === "connection.ack",
      "connection.ack",
      5_000,
      from,
    );
    this.log(
      `${this.name} connected to ${gatewayUrl}${resume ? " (resuming)" : ""}`,
    );
  }

  private live(): WebSocket {
    if (!this.socket) throw new Error(`${this.name} is not connected`);
    return this.socket;
  }

  /** Mint the key BEFORE the send, per FR-SDK-06 — a key generated on the
   * retry path is a key that cannot deduplicate anything (2.3's trap). */
  mintKey(): string {
    return `k-${randomUUID()}`;
  }

  send(channel: string, text: string, key = this.mintKey()): string {
    this.unacked.push({ text, channel, key });
    this.live().send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: key, channel, text },
      }),
    );
    return key;
  }

  /** Stage 2's star: write the frame, then destroy the transport before any
   * ack can come back. `terminate()` and no await — an ack cannot arrive in
   * the same tick, so the kill is protocol-timed, not sleep-timed. */
  sendAndKillBeforeAck(channel: string, text: string, key: string): void {
    this.send(channel, text, key);
    this.live().terminate();
    this.log(`${this.name} sent "${text}" and lost the socket before any ack`);
  }

  /** Re-send everything the socket died owing, with the ORIGINAL keys. */
  flushQueue(): void {
    const queued = [...this.unacked];
    this.unacked.length = 0;
    for (const item of queued) {
      this.log(`${this.name} retries "${item.text}" with its original key`);
      this.send(item.channel, item.text, item.key);
    }
  }

  close(): void {
    this.socket?.close();
  }

  async waitFor(
    predicate: (frame: Frame) => boolean,
    what: string,
    timeoutMs = 5_000,
    from = 0,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`${this.name}: no ${what} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Wait for a specific message text to arrive — a delivery assertion that
   * polls with a deadline instead of sleeping and hoping (2.8's trap). */
  expectCreated(text: string, timeoutMs = 5_000, from = 0): Promise<Frame> {
    return this.waitFor(
      (f) => f.type === "message.created" && f.payload.text === text,
      `message.created "${text}"`,
      timeoutMs,
      from,
    );
  }

  /** Come back — possibly on a different instance (CON-02), always with the
   * cursor this client applied. Everything it knew survives: the frames it
   * rendered, the sends it still owes. */
  async reconnect(gatewayUrl: string): Promise<number> {
    const from = this.frames.length;
    await this.connect(gatewayUrl, true);
    return from;
  }

  /** Everything this client believes about a channel, in arrival order. */
  timeline(channel: string): Message[] {
    return this.frames
      .filter(
        (f): f is Extract<Frame, { type: "message.created" }> =>
          f.type === "message.created" && f.payload.channel === channel,
      )
      .map((f) => f.payload);
  }
}

export interface System {
  gateways: string[];
  apiUrl: string;
  log: string[];
  /** The services' own logs, for when an assertion is not the whole story. */
  serviceOutput: () => string;
  seedConversation: () => Promise<{
    environmentId: string;
    /** An API key for that environment — the credential the REST assertions
     * present now that the asserted header is gone (chapter 3.2). */
    credential: string;
    channel: string;
    dispatcher: Client;
    tuan: Client;
  }>;
  seedForeignTenant: () => Promise<{ channel: string; text: string }>;
  /** Set an environment's quota policy (chapter 3.10).
   *
   * Here rather than in the test, because `packages/e2e` may not import `pg` —
   * the driver restriction chapter 2.5 added, and this package is not on its
   * ignores list. The harness already holds the api's own database handle, so
   * the one place that may write is the one place that does. */
  setQuota: (environmentId: string, config: unknown) => Promise<void>;
  client: (name: string, environmentId: string) => Promise<Client>;
  stop: () => Promise<void>;
}

export async function boot({ gateways = 2 } = {}): Promise<System> {
  const { db, seeder } = loadApiInternals();
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    console.log(`  ${line}`);
  };

  const children: ChildProcess[] = [];
  /** Child stdio is CAPTURED, not discarded. A suite that boots processes
   * and then hides their logs cannot explain its own failures, and the one
   * thing a milestone must do when it goes red is say where to look. */
  const output = new Map<string, string[]>();
  const capture = (name: string, child: ChildProcess) => {
    const lines: string[] = [];
    output.set(name, lines);
    child.stdout?.on("data", (d: Buffer) => lines.push(d.toString().trim()));
    child.stderr?.on("data", (d: Buffer) => lines.push(d.toString().trim()));
    child.on("exit", (code, signal) => {
      if (code !== 0 && signal === null) lines.push(`exited with code ${code}`);
    });
    return child;
  };
  const dump = (what: string) => {
    const lines = [`${what}; child output follows:`];
    for (const [name, log] of output) {
      lines.push(`--- ${name} ---`, ...log.slice(-12));
    }
    return lines.join("\n");
  };
  const env = {
    ...process.env,
    ...forwarded(
      "DATABASE_URL",
      "RELAY_POSTGRES_PORT",
      "RELAY_REDIS_URL",
      "RELAY_REDIS_PORT",
      // Chapter 3.3: the api's relay needs the broker's address. Forwarded,
      // never composed here — a harness that invents a URL becomes a second
      // source of truth, which is exactly how this suite first failed.
      "RELAY_NATS_URL",
      "RELAY_NATS_PORT",
      // Chapter 3.5: the api decrypts webhook signing secrets and authenticates
      // the dispatcher. Both are configuration, and a child that invents either
      // would be a second source of truth for a credential.
      "RELAY_WEBHOOK_SECRET_KEY",
      "RELAY_INTERNAL_CREDENTIAL",
      // Chapter 3.8: the failed-authentication threshold and the counter's key
      // prefix. Forwarded for the reason this list exists at all — turbo runs
      // tasks in STRICT env mode, so an undeclared variable reaches a child as
      // `undefined` and the `??` behind it silently wins. A suite that raised the
      // threshold would raise it in the parent and not in the api the child runs.
      "RELAY_AUTH_FAILURES_PER_MINUTE",
      "RELAY_AUTH_KEY_PREFIX",
      // Chapter 3.8's other half: where the notification relay posts its SMTP.
      // The lane runs Mailpit on 11025 and the default is 1025, so an
      // unforwarded variable is not a missing feature — it is a mailer talking
      // confidently to a port nothing is listening on.
      "RELAY_SMTP_URL",
    ),
    // Chapter 3.3: the api children run WITHOUT the outbox relay. This journey
    // asserts message delivery, and a background loop draining the outbox while
    // 3.3's own suite asserts on that same table is a race between two test
    // files, not a property of the system. The relay has its own suite, which
    // drives it explicitly.
    RELAY_OUTBOX_RELAY: "off",
    // Chapter 3.8: and no notification relay either, for the same reason. This
    // journey asserts message delivery; a loop marking rows delivered while
    // 3.8's own suite asserts on that column is a race between test files.
    RELAY_NOTIFICATION_RELAY: "off",
    // Chapter 3.4: no event consumer in these children either, for the reason
    // the line above exists — this journey asserts message delivery, and a
    // background consumer writing to a table 3.4's suite asserts on is a race
    // between test files rather than a property of the system.
    RELAY_EVENT_CONSUMER: "off",
    // Chapter 3.5: nor the delivery relay, for the third time and the same
    // reason. Three background loops now share tables that other suites assert
    // on, and each one had to be silenced here the moment it existed — which is
    // the general form of 3.3's finding 4 rather than a coincidence.
    RELAY_DELIVERY_RELAY: "off",
  };

  const apiPort = Number(process.env.RELAY_E2E_API_PORT ?? 4100);
  children.push(
    capture(
      "api",
      spawn("node", [join(REPO, "services", "api", "dist", "main.js")], {
        env: { ...env, PORT: String(apiPort) },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ),
  );
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(`${apiUrl}/healthz`, "api");
  say(`api up on ${apiPort}`);

  const urls: string[] = [];
  for (let i = 0; i < gateways; i++) {
    const port = apiPort + 1 + i;
    children.push(
      capture(
        `gateway ${i + 1}`,
        spawn("pnpm", ["exec", "tsx", "src/main.ts"], {
          cwd: join(REPO, "services", "gateway"),
          env: { ...env, PORT: String(port), RELAY_API_URL: apiUrl },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    );
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, `gateway ${i + 1}`);
    urls.push(`ws://127.0.0.1:${port}`);
    say(`gateway ${i + 1} up on ${port}`);
  }

  const environments: string[] = [];
  const newEnvironment = async (label: string) => {
    const created = await seeder.createEnvironment(db, {
      name: `e2e-${label}-${randomUUID().slice(0, 8)}`,
    });
    environments.push(created.id);
    return new seeder.Repository(db, created.id);
  };

  /** Chapter 3.2: the harness cannot sign a token any more, and that is the
   * point — nothing outside the api holds a signing secret. It asks the api's
   * development endpoint instead, with the environment's own key, which is
   * exactly the path a reader follows to get their first token (FR-AUT-09). */
  const keys = new Map<string, string>();
  const keyFor = async (environmentId: string) => {
    const existing = keys.get(environmentId);
    if (existing !== undefined) return existing;
    const minted = await seeder.createApiKey(db, { environmentId });
    keys.set(environmentId, minted.credential);
    return minted.credential;
  };

  const token = async (environmentId: string, subject: string) => {
    const res = await fetch(`${apiUrl}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await keyFor(environmentId)}`,
      },
      body: JSON.stringify({ user: subject }),
    });
    if (!res.ok) {
      throw new Error(`dev-token failed: ${res.status} ${await res.text()}`);
    }
    return ((await res.json()) as { token: string }).token;
  };

  let primaryEnvironment = "";

  return {
    gateways: urls,
    apiUrl,
    log,
    serviceOutput: () => dump("service output"),
    async seedConversation() {
      const repo = await newEnvironment("fleet");
      primaryEnvironment = environments.at(-1)!;
      const dispatcherUser = await repo.createUser("dispatcher", "Dispatcher");
      const tuanUser = await repo.createUser("tuan", "Tuan");
      const channel = await repo.createChannel("fleet", "public");
      await repo.addMember(channel.id, dispatcherUser.id);
      await repo.addMember(channel.id, tuanUser.id);
      say(`seeded one channel with two members in ${primaryEnvironment}`);
      return {
        environmentId: primaryEnvironment,
        // Chapter 3.2: the REST assertions present a credential, not a header.
        credential: await keyFor(primaryEnvironment),
        channel: channel.id,
        dispatcher: new Client(
          "dispatcher",
          await token(primaryEnvironment, "dispatcher"),
          say,
        ),
        tuan: new Client("tuan", await token(primaryEnvironment, "tuan"), say),
      };
    },
    /** A second tenant with traffic of its own. Nothing in journey 4 asks
     * for it; constitution I asks for it everywhere correctness is being
     * asserted, so it rides along. */
    async seedForeignTenant() {
      const repo = await newEnvironment("other");
      const other = environments.at(-1)!;
      const user = await repo.createUser("stranger", "Stranger");
      const channel = await repo.createChannel("theirs", "public");
      await repo.addMember(channel.id, user.id);
      const text = "this belongs to another tenant";
      await repo.sendMessage(channel.id, { text, userId: user.id });
      say(`seeded a foreign tenant (${other}) with one message`);
      return { channel: channel.id, text };
    },
    async setQuota(environmentId, config) {
      await (
        db as { execute: (q: string) => Promise<unknown> }
      ).execute(
        `UPDATE environments SET quota_config = '${JSON.stringify(config)}'::jsonb
          WHERE id = '${environmentId}'`,
      );
    },
    async client(name, environmentId) {
      return new Client(name, await token(environmentId, name), say);
    },
    async stop() {
      for (const child of children) child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
}
