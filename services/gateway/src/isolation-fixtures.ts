import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Two tenants and a running api, for the socket half of the gauntlet.
 *
 * SEEDING GOES THROUGH THE API'S OWN REPOSITORY, imported from its build output — the
 * test-only seam chapter 2.8 established, for the same reason: there is no admin API for
 * environments or keys, and inventing one for a test would be inventing product. The
 * gateway does not depend on the api package and must not start.
 *
 * THE API RUNS AS A CHILD AND THE GATEWAY IN PROCESS. In process, because a test that
 * cannot reach the gateway's own state cannot check what it subscribed to; as a child,
 * because importing the api would make this service depend on the api's framework to
 * test itself, and not knowing how the api is built is the whole of ADR-05. */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (
    db: unknown,
    input: { environmentId: string },
  ) => Promise<{ credential: string }>;
  Repository: new (
    db: unknown,
    environmentId: string,
  ) => {
    createUser: (externalId: string, name?: string) => Promise<{ id: string }>;
    createChannel: (
      externalId: string,
      type: string,
      name?: string,
    ) => Promise<{ id: string }>;
    addMember: (channelId: string, userId: string) => Promise<boolean>;
    // WIDENED TO WHAT THE REPOSITORY ACTUALLY TAKES AND RETURNS. This cast is a
    // hand-written declaration of another package's function — the gateway may not
    // import service source — so it can be narrower than the truth without anything
    // failing. It was, in both directions: no `userExternalId` and no `seq`, both of
    // which the real signature has carried since the sender field arrived. A cast
    // that omits a parameter makes passing it a type error, which is how this was
    // found: by needing the parameter, not by reading the cast.
    sendMessage: (
      channelId: string,
      input: {
        text: string;
        userId?: string;
        userExternalId?: string;
        metadata?: Record<string, unknown>;
        idempotencyKey?: string;
      },
    ) => Promise<{ id: string; seq: number }>;
  };
}

export interface SocketTenant {
  environmentId: string;
  credential: string;
  userExternalId: string;
  userId: string;
  channelId: string;
  /** A private channel in the same environment that this tenant's user is NOT a
   * member of. */
  privateChannelId: string;
  /** That private channel's history, read with the APPLICATION key — which sees
   * private channels (FR-005) — so a refused send can be checked against the
   * rows rather than against its own error frame. */
  privateHistory: () => Promise<string>;
  /** Removes this tenant's user from its own channel via the public route. */
  removeSelf: () => Promise<void>;
  rejoinSelf: () => Promise<void>;
  archiveOwnChannel: () => Promise<void>;
  unarchiveOwnChannel: () => Promise<void>;
  /** A token for `userExternalId`, minted through the api's own dev-token route so
   * the signing secret never leaves the api — research R1's rule, and the reason
   * the gateway asks rather than verifies. */
  token: string;
  /** Put a message in this tenant's channel, so a foreign subscriber has something
   * it must not receive. */
  say: (text: string) => Promise<{ id: string; seq: number }>;
  /** This tenant's own channel history, read with its own credential through the
   * public route. A write attack has to be checked against the victim's state and
   * not against the attacker's refusal: a refusal that changed a row is still a
   * breach, and only the victim's side of the wire can tell. */
  history: () => Promise<string>;
}

export interface SocketTenants {
  /** The caller. Its token is the one every attack presents. */
  attacker: SocketTenant;
  /** The tenant whose identifiers the attacker borrows. */
  victim: SocketTenant;
  apiUrl: string;
  stop: () => void;
}

/** THE PORT COMES FROM THE CHILD, NOT FROM A TABLE.
 *
 * The api is started with `PORT=0` and reports the port it bound. A hand-allocated band
 * per suite is a table nothing checks: two suites eventually overlap, or a band grows to
 * contain a port the lane itself runs, and the failure is a health check that succeeds
 * against the wrong service. Asking the operating system removes the table. */
export async function startApi(
  // EXTRA ENV, BECAUSE THE SECOND CALLER NEEDED IT AND A SECOND COPY IS A SECOND RULE.
  // `public-surface.itest.ts` spawns an api child too, and it arrived with a
  // hand-allocated band of its own — 4800-5000, with a comment naming three other
  // suites' bands and one file's fixed 4124. That comment was already wrong when it
  // was written; two of the files it names do not exist yet. Exporting this is
  // cheaper than keeping the table honest, which is the same argument as deleting it.
  extra: Readonly<Record<string, string>> = {},
): Promise<{ url: string; stop: () => void }> {
  const dist = join(REPO, "services", "api", "dist");
  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: { ...process.env, ...extra, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("api never reported a port")), 30_000);
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === "listening" && typeof parsed.port === "number") {
            clearTimeout(timer);
            resolve(parsed.port);
            return;
          }
        } catch {
          /* a partial line; the next chunk completes it */
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`api exited before listening (code ${String(code)})`));
    });
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

export async function seedSocketTenants(): Promise<SocketTenants> {
  const dist = join(REPO, "services", "api", "dist");
  const client = require_(join(dist, "db", "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
  const db = client.createDb(client.createPool());

  // THE API STARTS FIRST NOW, and the order is forced rather than tidier. This
  // chapter's fixture needs two things the previous one did not: a token minted
  // through the api's own dev-token route, and a history read over the public route
  // — both of which need a URL. Seeding before starting left `apiUrl` and `token`
  // out of scope inside this closure, which the compiler said and a reader would
  // not: the fields were named in the interface and filled in nowhere.
  const api = await startApi();

  const seed = async (label: string): Promise<SocketTenant> => {
    const environment = await seeder.createEnvironment(db, {
      name: `socket-isolation-${label}-${randomUUID().slice(0, 8)}`,
    });
    const repo = new seeder.Repository(db, environment.id);
    const userExternalId = `${label}-user`;
    const user = await repo.createUser(userExternalId, `${label} user`);
    const channel = await repo.createChannel(`${label}-channel`, "public");
    await repo.addMember(channel.id, user.id);
    // A PRIVATE channel in the same tenant, and this user is NOT a
    // member of it. The four cross-tenant shapes all attack with another tenant's
    // identifiers; a non-member of your own tenant is a different fixture, and the
    // socket needs one too because `message.send` reaches the same check.
    const privateChannel = await repo.createChannel(`${label}-private`, "private");
    const key = await seeder.createApiKey(db, { environmentId: environment.id });
    return {
      environmentId: environment.id,
      credential: key.credential,
      userExternalId,
      userId: user.id,
      channelId: channel.id,
      privateChannelId: privateChannel.id,
      // Minted through the api rather than signed here: the signing secret never
      // leaves the api (research R1), which is also why the gateway asks the api to
      // verify rather than verifying itself.
      token: await mintToken(api.url, key.credential, userExternalId),
      say: (text: string) =>
        repo.sendMessage(channel.id, { text, userId: user.id, userExternalId }),
      /** Remove this tenant's own user from its own public channel, through the
       * public route — so the test asserts the consequence of the API rather than of
       * a direct write. */
      removeSelf: async () => {
        const res = await fetch(
          `${api.url}/v1/channels/${channel.id}/members/remove`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key.credential}`,
            },
            body: JSON.stringify({ user_ids: [userExternalId] }),
          },
        );
        if (!res.ok) throw new Error(`removeSelf for ${label}: ${res.status}`);
      },
      /** Archive and unarchive this tenant's own channel through the public routes,
       * so the socket test observes the API's effect rather than a direct write. */
      /** Put the membership back. A test that mutates shared fixture state has to
       * restore it: T058 removed the attacker from their own channel and did not,
       * and T078a two tests later failed on its control because the "member" was no
       * longer one. The fixture's invariant — this tenant's user is a member of this
       * tenant's channel — belongs to every test in the file, not to the first one
       * that gets there. */
      rejoinSelf: async () => {
        const res = await fetch(
          `${api.url}/v1/channels/${channel.id}/members`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key.credential}`,
            },
            body: JSON.stringify({ user_ids: [userExternalId] }),
          },
        );
        if (!res.ok) throw new Error(`rejoinSelf for ${label}: ${res.status}`);
      },
      archiveOwnChannel: async () => {
        const res = await fetch(`${api.url}/v1/channels/${channel.id}/archive`, {
          method: "POST",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`archive for ${label}: ${res.status}`);
      },
      unarchiveOwnChannel: async () => {
        const res = await fetch(`${api.url}/v1/channels/${channel.id}/archive`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`unarchive for ${label}: ${res.status}`);
      },
      privateHistory: async () => {
        const res = await fetch(
          `${api.url}/v1/channels/${privateChannel.id}/messages?limit=100`,
          { headers: { authorization: `Bearer ${key.credential}` } },
        );
        if (!res.ok) throw new Error(`private history for ${label}: ${res.status}`);
        return res.text();
      },
      history: async () => {
        const res = await fetch(`${api.url}/v1/channels/${channel.id}/messages?limit=100`, {
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`history for ${label}: ${res.status}`);
        return res.text();
      },
    };
  };

  const attacker = await seed("attacker");
  const victim = await seed("victim");
  return { attacker, victim, apiUrl: api.url, stop: api.stop };
}

/** A token for one tenant's user, minted with that tenant's key. */
export async function mintToken(
  apiUrl: string,
  credential: string,
  user: string,
): Promise<string> {
  const res = await fetch(`${apiUrl}/auth/dev-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });
  if (!res.ok) throw new Error(`dev-token: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}
