import { createApiKey, createEnvironment, Repository } from "../db/repository";
import { encryptSecret, mintSigningSecret } from "../webhooks/secret";

import type { Db } from "../db/client";

/** Two tenants, so every attack has a victim and an attacker (chapter 3.12).
 *
 * The gauntlet's unit of assertion is a PAIR of requests — another tenant's
 * identifier and an identifier that exists nowhere — and it needs a second tenant
 * to borrow identifiers from. One environment can only prove that a made-up uuid
 * is not found, which is a much weaker claim than the one constitution I makes.
 *
 * EVERY ROW IS SCOPED TO AN ENVIRONMENT THIS FUNCTION MINTED, and nothing here
 * deletes anything. Feature 030's whole subject is a test that performs a global
 * operation and asserts a local fact; a fixture that tidied up with a
 * `DELETE FROM channels` would be the eleventh instance of it. The environments
 * are disposable and the lane shares the database — that is the trade chapter 2.1
 * made when it put `environment_id` in every table, and it pays for itself here.
 *
 * ONE OF EACH KIND OF ROW THE ROUTES TOUCH, because the write attacks read
 * storage before and after: a channel and a message for the message routes, a
 * user for membership and the session route, a webhook endpoint for the seven
 * webhook routes. */
export interface Tenant {
  environmentId: string;
  /** This tenant's own bot (chapter 3.17). A key send must name one. */
  botExternalId: string;
  /** An `rk_dev_…` credential for this environment, minted the way signup does. */
  credential: string;
  userId: string;
  userExternalId: string;
  channelId: string;
  /** The customer-supplied identifier, so the create attack can present the other
   * tenant's own external id. */
  channelExternalId: string;
  messageId: string;
  endpointId: string;
  repo: Repository;
}

export interface TwoTenants {
  /** The caller. Its credential is the one every attack presents. */
  attacker: Tenant;
  /** The tenant whose identifiers the attacker borrows. Nothing it owns may move. */
  victim: Tenant;
}

async function seedTenant(db: Db, label: string): Promise<Tenant> {
  const environment = await createEnvironment(db, { name: `isolation-${label}` });
  const key = await createApiKey(db, { environmentId: environment.id });
  const repo = new Repository(db, environment.id);

  const userExternalId = `${label}-user`;
  const user = await repo.createUser(userExternalId, `${label} user`);
  // A BOT PER TENANT (chapter 3.17). Every attack in the gauntlet presents a KEY, and a
  // key send names a bot — so each tenant needs one of its own, or an attack would be
  // refused for naming an unresolvable sender rather than for the thing it attacks.
  const bot = (
    await repo.upsertUser(`${label}-bot`, {
      kind: "bot",
      description: `${label}'s own software`,
    })
  ).user;
  const channel = await repo.createChannel(`${label}-channel`, "public", `${label}`);
  await repo.addMember(channel.id, user.id);
  const message = await repo.sendMessage(channel.id, {
    text: `${label} says something`,
    userId: user.id,
    userExternalId,
  });
  const endpoint = await repo.createEndpoint({
    url: `https://${label}.example/hook`,
    eventTypes: ["message.created"],
    secretCiphertext: encryptSecret(mintSigningSecret()),
  });

  return {
    environmentId: environment.id,
    credential: key.credential,
    botExternalId: bot.external_id,
    userId: user.id,
    userExternalId,
    channelId: channel.id,
    channelExternalId: `${label}-channel`,
    messageId: message.id,
    endpointId: endpoint.id,
    repo,
  };
}

/** Mint the pair. Labels carry a suffix so two suites running in parallel do not
 * collide on `channels_environment_id_external_id_unique` — the identifiers are
 * per environment, but the label is what a failure message shows a reader. */
export async function seedTwoTenants(db: Db): Promise<TwoTenants> {
  const stamp = Math.random().toString(36).slice(2, 8);
  const [attacker, victim] = await Promise.all([
    seedTenant(db, `a-${stamp}`),
    seedTenant(db, `v-${stamp}`),
  ]);
  return { attacker, victim };
}

/** A well-formed identifier belonging to nobody — the other half of every pair.
 *
 * It has to be a valid uuid, or the endpoint refuses it for the wrong reason: a
 * malformed id is a 400 from validation and a foreign id is a 404 from the
 * repository, and comparing those two would pass a suite that proves nothing. */
export function nowhereId(): string {
  return "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

/** ONE TENANT, TWO USERS, AND A PRIVATE CHANNEL ONE OF THEM IS NOT IN.
 *
 * Chapter 3.15, FR-034. `seedTwoTenants` above gives every attack a victim in
 * ANOTHER environment, and all four attack shapes take an identifier that does not
 * exist in the attacker's own tenant. A non-member of your OWN tenant is a
 * different case entirely: the channel is right there, the environment predicate
 * passes, and the only thing standing between the caller and the rows is a
 * membership check this chapter wrote.
 *
 * So this is new work rather than a reuse, and the suite had no fixture for it —
 * measured before building it, which is why FR-034 says so.
 */
export interface SameTenant {
  environmentId: string;
  credential: string;
  /** A member of the private channel. The control's subject. */
  member: { id: string; externalId: string; token: string };
  /** A user of the same tenant who is NOT a member of it. The attacker. */
  stranger: { id: string; externalId: string; token: string };
  privateChannelId: string;
  publicChannelId: string;
  /** A message the member wrote, so a read attack has something to fail to find. */
  messageId: string;
  /** A bot of this tenant (chapter 3.17). The control's sender: an application
   * credential may name this one and no other tenant's. */
  bot: { id: string; externalId: string };
  repo: Repository;
}

export async function seedSameTenant(db: Db, mintToken: MintToken): Promise<SameTenant> {
  const stamp = Math.random().toString(36).slice(2, 8);
  const environment = await createEnvironment(db, { name: `iso-same-${stamp}` });
  const key = await createApiKey(db, { environmentId: environment.id });
  const repo = new Repository(db, environment.id);

  const member = await repo.createUser(`same-${stamp}-member`, "A Member");
  const stranger = await repo.createUser(`same-${stamp}-stranger`, "A Stranger");
  const privateChannel = await repo.createChannel(`same-${stamp}-private`, "private");
  const publicChannel = await repo.createChannel(`same-${stamp}-public`, "public");
  await repo.addMember(privateChannel.id, member.id);
  const message = await repo.sendMessage(privateChannel.id, {
    text: "written by a member",
    userId: member.id,
    userExternalId: member.external_id,
  });
  // A BOT, VIA THE UPSERT, because `createUser` cannot set `kind` — a bot needs a
  // description and the member-add path has nowhere to put one (chapter 3.17).
  const bot = (
    await repo.upsertUser(`same-${stamp}-bot`, {
      display_name: "A Bot",
      kind: "bot",
      description: "the tenant's own software, for the sender attacks",
    })
  ).user;

  return {
    environmentId: environment.id,
    credential: key.credential,
    member: {
      id: member.id,
      externalId: member.external_id,
      token: await mintToken(environment.id, member.external_id),
    },
    stranger: {
      id: stranger.id,
      externalId: stranger.external_id,
      token: await mintToken(environment.id, stranger.external_id),
    },
    privateChannelId: privateChannel.id,
    publicChannelId: publicChannel.id,
    messageId: message.id,
    bot: { id: bot.id, externalId: bot.external_id },
    repo,
  };
}

/** THE SAME `external_id` IN TWO ENVIRONMENTS, ONE PUBLIC AND ONE PRIVATE.
 *
 * Chapter 3.15, FR-034a. `seedTenant` above label-prefixes every identifier —
 * `${label}-channel` — so the two tenants it mints never share one, and all four
 * attack shapes take an id that does NOT exist in the attacker's tenant. The case
 * where the same STRING resolves in both, to channels of different types, has no
 * fixture at all.
 *
 * AND THIS FEATURE IS WHAT MAKES IT WORTH TESTING. Before it, both channels would
 * have been `public` and the two answers matched trivially. Now one tenant's user
 * gets 200 for a string that another tenant's non-member gets 404 for — and the
 * reason must be the TYPE, not the tenant. A route that resolved an external id
 * without scoping would cross the boundary and look correct doing it.
 */
export interface CollidingTenants {
  /** The tenant whose channel of this name is public. */
  open: { environmentId: string; credential: string; token: string; channelId: string };
  /** The tenant whose channel of the SAME name is private, with a non-member. */
  closed: { environmentId: string; credential: string; token: string; channelId: string };
  /** The one external id both channels carry. */
  sharedExternalId: string;
}

export async function seedCollidingTenants(
  db: Db,
  mintToken: MintToken,
): Promise<CollidingTenants> {
  const stamp = Math.random().toString(36).slice(2, 8);
  const sharedExternalId = `collide-${stamp}`;

  const seed = async (label: string, type: "public" | "private") => {
    const environment = await createEnvironment(db, { name: `iso-collide-${label}-${stamp}` });
    const key = await createApiKey(db, { environmentId: environment.id });
    const repo = new Repository(db, environment.id);
    const userExternalId = `collide-${label}-${stamp}-user`;
    const user = await repo.createUser(userExternalId);
    // THE SAME external id in both environments. `DR-02` makes it unique per
    // environment, which is exactly the property under test.
    const channel = await repo.createChannel(sharedExternalId, type);
    // The `public` tenant's user is deliberately NOT a member either: this fixture
    // is about type deciding the answer, and membership would confound it.
    return {
      environmentId: environment.id,
      credential: key.credential,
      token: await mintToken(environment.id, userExternalId),
      channelId: channel.id,
      userId: user.id,
    };
  };

  const [open, closed] = await Promise.all([seed("open", "public"), seed("closed", "private")]);
  return { open, closed, sharedExternalId };
}

/** How a fixture mints an end-user token. Injected rather than imported so
 * `fixtures.ts` stays free of the auth module — the gauntlet's api-side fixtures
 * have never needed it, and the two suites that do want tokens already know how. */
export type MintToken = (environmentId: string, userExternalId: string) => Promise<string>;
