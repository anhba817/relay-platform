import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "./client";
import { migrate } from "./migrate";
import { createEnvironment, Repository, type Environment } from "./repository";

// The isolation suite: attack the repository with FOREIGN tenant ids and
// prove the leak inexpressible (FR-TEN-05, NFR-SEC-09, constitution I).
// Requires the compose Postgres — this file is *.itest.ts precisely so the
// Docker-free unit lane never collects it.

// Guardrail: integration tests run against the LOCAL compose stack only.
const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}") — never point this suite at a shared database`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let envA: Environment;
let envB: Environment;
let repoA: Repository;
let repoB: Repository;

beforeAll(async () => {
  await migrate(pool);
  // Deterministic ground: this suite owns these tables in the dev database.
  await pool.query(
    "TRUNCATE members, messages, channels, users, environments, applications CASCADE",
  );
  envA = await createEnvironment(db, { name: "tenant-a" });
  envB = await createEnvironment(db, { name: "tenant-b" });
  repoA = new Repository(db, envA.id);
  repoB = new Repository(db, envB.id);
});

afterAll(async () => {
  await pool.end();
});

describe("tenant isolation is structural (FR-TEN-05)", () => {
  it("a foreign external_id resolves to nothing — not even an existence hint", async () => {
    await repoA.createUser("tuan", "Tuan");
    expect(await repoA.getUserByExternalId("tuan")).not.toBeNull();
    expect(await repoB.getUserByExternalId("tuan")).toBeNull();
  });

  it("channel reads and lists are scoped by construction", async () => {
    await repoA.createChannel("support", "public", "Support");
    expect(await repoB.getChannelByExternalId("support")).toBeNull();
    expect(await repoB.listChannels()).toEqual([]);
    expect((await repoA.listChannels()).map((c) => c.external_id)).toContain(
      "support",
    );
  });

  it("membership writes with foreign ids affect zero rows", async () => {
    const user = await repoA.getUserByExternalId("tuan");
    const channel = await repoA.getChannelByExternalId("support");
    expect(await repoA.addMember(channel!.id, user!.id)).toBe(true);
    // B holds A's REAL ids — and still cannot write or read through them.
    expect(await repoB.addMember(channel!.id, user!.id)).toBe(false);
    expect(await repoB.listMembers(channel!.id)).toEqual([]);
    expect(await repoB.channelsForUser(user!.id)).toEqual([]);
    expect(await repoA.listMembers(channel!.id)).toEqual([user!.id]);
  });

  it("uniqueness is per-tenant (DR-02): both tenants may own the same external_id", async () => {
    await expect(
      repoB.createUser("tuan", "A different Tuan"),
    ).resolves.toBeTruthy();
    await expect(repoA.createUser("tuan", "Duplicate in A")).rejects.toThrow();
  });
});
