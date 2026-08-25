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
    /** Chapter 3.17. The gateway declares its own narrow view of the repository —
     * it has no database and must not gain one (research R12) — so a new fixture
     * capability means one more line here. */
    upsertUser: (
      externalId: string,
      profile: { kind?: "person" | "bot"; description?: string },
    ) => Promise<{ status: string }>;
  };
}

export interface SocketTenant {
  environmentId: string;
  credential: string;
  userExternalId: string;
  channelId: string;
  /** A private channel in the same environment that this tenant's user is NOT a
   * member of (chapter 3.15). */
  privateChannelId: string;
  /** That private channel's history, read with the APPLICATION key — which sees
   * private channels (FR-005) — so a refused send can be checked against the
   * rows rather than against its own error frame. */
  privateHistory: () => Promise<string>;
  /** A DISPOSABLE user of this tenant, with its own token, that a test may destroy
   * (chapter 3.17, T040b).
   *
   * NOT the tenant's own user. Promoting that one to a bot makes it unable to connect
   * for the rest of the file, and every test after it — including the control — fails.
   * That is the fifth time in two features a shared fixture has been the hazard, and
   * the fix is a fixture nobody else depends on rather than a rule nobody remembers. */
  disposable: () => Promise<{ token: string; promoteToBot: () => Promise<unknown> }>;
  /** Removes this tenant's user from its own channel via the public route. */
  removeSelf: () => Promise<void>;
  rejoinSelf: () => Promise<void>;
  archiveOwnChannel: () => Promise<void>;
  unarchiveOwnChannel: () => Promise<void>;
  /** A user and a channel nobody else in the suite touches, with one attributed message
   * already in it (chapter 3.15, T144).
   *
   * ITS OWN FIXTURE BECAUSE THE TEST DESTROYS IT. T144 deletes the user, and the first
   * version deleted the shared `victim` — which took the membership with it and made a
   * later test's profile PATCH answer 404. Phase 7 hit the same class twice: a test that
   * mutates a shared fixture breaks whichever test runs after it, and the fix is a
   * fixture of its own rather than an ordering constraint nobody can see. */
  /** Ban and unban this tenant's own user through the public route (chapter 3.15,
   * T153). */
  banSelf: () => Promise<void>;
  unbanSelf: () => Promise<void>;
  seedDeletable: () => Promise<{
    userExternalId: string;
    channelId: string;
    seq: number;
    witnessToken: string;
  }>;
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
    // Chapter 3.15: a PRIVATE channel in the same tenant, and this user is NOT a
    // member of it. The four cross-tenant shapes all attack with another tenant's
    // identifiers; a non-member of your own tenant is a different fixture, and the
    // socket needs one too because `message.send` reaches the same check.
    const privateChannel = await repo.createChannel(`${label}-private`, "private");
    const key = await seeder.createApiKey(db, { environmentId: environment.id });
    const token = await mintToken(apiUrl, key.credential, userExternalId);
    return {
      environmentId: environment.id,
      credential: key.credential,
      userExternalId,
      channelId: channel.id,
      privateChannelId: privateChannel.id,
      token,
      say: (text: string) =>
        repo.sendMessage(channel.id, { text, userId: user.id, userExternalId }),
      /** Turn this tenant's own user into a bot (chapter 3.17, T040b). Exposed rather
       * than done in the test, because the fixture owns the repository handle and the
       * test has no database of its own. */
      disposable: async () => {
        const who = `${label}-disposable-${Math.random().toString(36).slice(2, 8)}`;
        const row = await repo.createUser(who, "Disposable");
        await repo.addMember(channel.id, row.id);
        return {
          token: await mintToken(apiUrl, key.credential, who),
          promoteToBot: () =>
            repo.upsertUser(who, {
              kind: "bot",
              description: "promoted while holding a live token",
            }),
        };
      },
      /** Remove this tenant's own user from its own public channel, through the
       * public route — so the test asserts the consequence of the API rather than of
       * a direct write. */
      removeSelf: async () => {
        const res = await fetch(
          `${apiUrl}/v1/channels/${channel.id}/members/remove`,
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
          `${apiUrl}/v1/channels/${channel.id}/members`,
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
        const res = await fetch(`${apiUrl}/v1/channels/${channel.id}/archive`, {
          method: "POST",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`archive for ${label}: ${res.status}`);
      },
      banSelf: async () => {
        const res = await fetch(`${apiUrl}/v1/users/${userExternalId}/ban`, {
          method: "POST",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`ban ${userExternalId}: ${res.status}`);
      },
      unbanSelf: async () => {
        const res = await fetch(`${apiUrl}/v1/users/${userExternalId}/ban`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`unban ${userExternalId}: ${res.status}`);
      },
      seedDeletable: async () => {
        const label2 = `${label}-del-${Math.random().toString(36).slice(2, 7)}`;
        const doomed = await repo.createUser(`${label2}-doomed`, "Doomed");
        const witness = await repo.createUser(`${label2}-witness`, "Witness");
        const room = await repo.createChannel(`${label2}-room`, "public");
        await repo.addMember(room.id, doomed.id);
        await repo.addMember(room.id, witness.id);
        const sent = await repo.sendMessage(room.id, {
          text: "sent before the deletion",
          userId: doomed.id,
          userExternalId: `${label2}-doomed`,
        });
        return {
          userExternalId: `${label2}-doomed`,
          channelId: room.id,
          seq: sent.seq,
          witnessToken: await mintToken(apiUrl, key.credential, `${label2}-witness`),
        };
      },
      unarchiveOwnChannel: async () => {
        const res = await fetch(`${apiUrl}/v1/channels/${channel.id}/archive`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key.credential}` },
        });
        if (!res.ok) throw new Error(`unarchive for ${label}: ${res.status}`);
      },
      privateHistory: async () => {
        const res = await fetch(
          `${apiUrl}/v1/channels/${privateChannel.id}/messages?limit=100`,
          { headers: { authorization: `Bearer ${key.credential}` } },
        );
        if (!res.ok) throw new Error(`private history for ${label}: ${res.status}`);
        return res.text();
      },
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
