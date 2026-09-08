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
    sendMessage: (
      channelId: string,
      input: { text: string; userId?: string },
    ) => Promise<{ id: string }>;
  };
}

export interface SocketTenant {
  environmentId: string;
  credential: string;
  userExternalId: string;
  userId: string;
  channelId: string;
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
async function startApi(): Promise<{ url: string; stop: () => void }> {
  const dist = join(REPO, "services", "api", "dist");
  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: { ...process.env, PORT: "0" },
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

  const seed = async (label: string): Promise<SocketTenant> => {
    const environment = await seeder.createEnvironment(db, {
      name: `socket-isolation-${label}-${randomUUID().slice(0, 8)}`,
    });
    const repo = new seeder.Repository(db, environment.id);
    const userExternalId = `${label}-user`;
    const user = await repo.createUser(userExternalId, `${label} user`);
    const channel = await repo.createChannel(`${label}-channel`, "public");
    await repo.addMember(channel.id, user.id);
    await repo.sendMessage(channel.id, { text: `${label} says something`, userId: user.id });
    const key = await seeder.createApiKey(db, { environmentId: environment.id });
    return {
      environmentId: environment.id,
      credential: key.credential,
      userExternalId,
      userId: user.id,
      channelId: channel.id,
    };
  };

  const attacker = await seed("attacker");
  const victim = await seed("victim");
  const api = await startApi();
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
