import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Two tenants and a user token each, for the socket half of the gauntlet
 * (chapter 3.12, FR-007).
 *
 * WHY THE GATEWAY LANE AND NOT `packages/e2e`. A socket needs a real gateway, and
 * this lane has spawned a live api child since chapter 3.2 — so the gateway runs
 * in process, which is what lets a test drive its clock and read its state. The
 * e2e package is excluded from the coverage run by name, so a suite living only
 * there could not contribute to the branch figures FR-040 measures (research R1).
 *
 * SEEDING GOES THROUGH THE API'S BUILD OUTPUT, which is the test-only seam chapter
 * 2.8 opened and 3.2 widened, for the reason it gave: there is no admin API for
 * environments or keys, and inventing one for a test would be inventing product.
 * Chapter 3.12 narrows that seam for channels and members — those get public
 * endpoints in Phase 6 — and leaves environments and keys where they were, so this
 * file states the same retirement its ancestors did.
 *
 * `createRequire` rather than an import, because this package may not depend on
 * the api. That is also the escape hatch `packages/outsider` is forbidden from
 * using, which is worth noticing while writing it: the seal there is a lint rule
 * on paths, and this is what the rule exists to refuse. */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "..", "api", "dist");
const require_ = createRequire(import.meta.url);

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (db: unknown, input: { environmentId: string }) => Promise<{ credential: string }>;
  Repository: new (
    db: unknown,
    environmentId: string,
  ) => {
    createUser: (externalId: string, name?: string) => Promise<{ id: string }>;
    createChannel: (externalId: string, type: string, name?: string) => Promise<{ id: string }>;
    addMember: (channelId: string, userId: string) => Promise<boolean>;
    sendMessage: (
      channelId: string,
      input: { text: string; userId?: string; userExternalId?: string },
    ) => Promise<{ id: string; seq: number }>;
  };
}

export interface SocketTenant {
  environmentId: string;
  credential: string;
  userExternalId: string;
  channelId: string;
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
  attacker: SocketTenant;
  victim: SocketTenant;
}

async function mintToken(apiUrl: string, credential: string, user: string): Promise<string> {
  const res = await fetch(`${apiUrl}/auth/dev-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ user, ttl_seconds: 3600 }),
  });
  if (!res.ok) throw new Error(`dev-token for ${user}: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** Mint the pair against the api child this lane already runs. */
export async function seedSocketTenants(apiUrl: string): Promise<SocketTenants> {
  const client = require_(join(DIST, "db", "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(DIST, "db", "repository.js")) as Seeder;
  const db = client.createDb(client.createPool());
  const stamp = Math.random().toString(36).slice(2, 8);

  const seed = async (label: string): Promise<SocketTenant> => {
    const environment = await seeder.createEnvironment(db, { name: `iso-ws-${label}-${stamp}` });
    const repo = new seeder.Repository(db, environment.id);
    const userExternalId = `${label}-user`;
    const user = await repo.createUser(userExternalId, `${label} user`);
    const channel = await repo.createChannel(`${label}-channel`, "public");
    await repo.addMember(channel.id, user.id);
    const key = await seeder.createApiKey(db, { environmentId: environment.id });
    const token = await mintToken(apiUrl, key.credential, userExternalId);
    return {
      environmentId: environment.id,
      credential: key.credential,
      userExternalId,
      channelId: channel.id,
      token,
      say: (text: string) =>
        repo.sendMessage(channel.id, { text, userId: user.id, userExternalId }),
      history: async () => {
        const res = await fetch(`${apiUrl}/v1/channels/${channel.id}/messages?limit=100`, {
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`history for ${label}: ${res.status}`);
        return res.text();
      },
    };
  };

  // Sequential, not concurrent: both calls mint a token through the same api
  // child, and chapter 3.8's per-IP failed-auth limiter is the one bucket that
  // fails CLOSED. Two parallel signups are well under it, and a suite that
  // learns that the hard way learns it as an unrelated 429.
  const attacker = await seed("a");
  const victim = await seed("v");
  return { attacker, victim };
}
