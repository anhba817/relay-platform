import { createApiKey, createEnvironment, Repository } from "../db/repository";

import type { Db } from "../db/client";

/** Two tenants, so every attack has a victim and an attacker.
 *
 * The gauntlet's unit of assertion is a PAIR of requests — another tenant's identifier
 * and an identifier that exists nowhere — and it needs a second tenant to borrow
 * identifiers from. One environment can only prove that a made-up uuid is not found,
 * which is a much weaker claim than the one constitution I makes.
 *
 * EVERY ROW IS SCOPED TO AN ENVIRONMENT THIS FUNCTION MINTED, AND NOTHING HERE DELETES
 * ANYTHING. A fixture that tidied up with a `DELETE FROM channels` would be a global
 * operation asserting a local fact, and the lane shares one database — that is the
 * trade chapter 2.1 made when it put `environment_id` in every table, and it pays for
 * itself here. The environments are disposable; leaving them costs rows and no
 * correctness.
 *
 * ONE OF EACH KIND OF ROW THE ROUTES TOUCH, because the write attacks read storage
 * before and after: a channel and a message for the message routes, a user for the
 * session route. */
export interface Tenant {
  environmentId: string;
  /** An `rk_dev_…` credential for this environment, minted the way signup does. */
  credential: string;
  userId: string;
  userExternalId: string;
  channelId: string;
  /** The customer-supplied identifier, so an attack can present the other tenant's own
   * external id rather than only its uuid. */
  channelExternalId: string;
  messageId: string;
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
  const channelExternalId = `${label}-channel`;
  const channel = await repo.createChannel(channelExternalId, "public", label);
  await repo.addMember(channel.id, user.id);
  const message = await repo.sendMessage(channel.id, {
    text: `${label} says something`,
    userId: user.id,
  });

  return {
    environmentId: environment.id,
    credential: key.credential,
    userId: user.id,
    userExternalId,
    channelId: channel.id,
    channelExternalId,
    messageId: message.id,
    repo,
  };
}

/** Seeded sequentially rather than with `Promise.all`, so a failure names which tenant
 * failed to seed instead of rejecting whichever lost the race. */
export async function seedTwoTenants(db: Db): Promise<TwoTenants> {
  const attacker = await seedTenant(db, `attacker-${Date.now().toString(36)}`);
  const victim = await seedTenant(db, `victim-${Date.now().toString(36)}`);
  return { attacker, victim };
}
