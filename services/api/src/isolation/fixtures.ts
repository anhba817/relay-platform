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
