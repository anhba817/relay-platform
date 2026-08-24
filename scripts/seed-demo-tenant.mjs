// A tenant an outsider can integrate against (chapter 3.14, FR-032).
//
// The constitution asks that `docker compose up` yield a working local platform
// "including a seeded demo tenant". Nothing seeded one, and until this chapter
// nothing needed to: every suite mints its own environment through the repository
// layer. `packages/outsider` cannot — it is mechanically forbidden from importing
// workspace code, which is the whole point of it — so it needs a credential that
// already exists before it starts.
//
// A SCRIPT AND NOT AN ENDPOINT, and the reason is worth stating rather than
// deferring. Creating an organisation is the sign-up flow's job (chapter 3.4), and
// the sign-up flow ends at an OAuth consent screen that no automated integration
// can complete. Minting a key is the dashboard's job, which chapter 3.2 deferred
// by name. Inventing either as an API for a test would be inventing product — the
// rule chapter 2.8 set for `listMessagesRaw` and every seam since.
//
//   RELAY_POSTGRES_PORT=15432 docker compose up -d --wait
//   DATABASE_URL=postgres://relay:relay@localhost:15432/relay \
//     node services/api/dist/db/migrate.js
//   node scripts/seed-demo-tenant.mjs
//
// ORDER IS LOAD-BEARING: this writes rows the api's schema must already accept, so
// the migration comes first. The suite then needs the credential this prints, so
// the seed comes before the suite. Stores, migrations, services, seed, suite.
//
// IDEMPOTENT ON THE NAME. Re-running it is the ordinary case — a developer runs it
// twice, CI runs it once per job — and a second organisation called `demo` with a
// second key would leave two credentials where the printed one is whichever the
// script happened to make last. So an existing demo environment is reused and its
// key is reissued, because a key's plaintext exists only at the moment it is
// minted: the row keeps a hash, by design (chapter 3.2), so there is nothing to
// print for a key that already exists.
import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createApiKey,
  createEnvironment,
} from "../services/api/dist/db/repository.js";

const NAME = process.env.RELAY_DEMO_TENANT_NAME ?? "demo";

// The POOL for the lookup and the repository's helpers for the writes. Drizzle
// is not importable from here — pnpm's isolated `node_modules` puts it under the
// api's tree, not the workspace root — and the pool is what `createDb` was given
// anyway, so this borrows no dependency the api does not already own.
const pool = createPool();
const db = createDb(pool);

const existing = (
  await pool.query(
    `SELECT e.id FROM environments e
       JOIN applications a ON a.id = e.application_id
       JOIN organisations o ON o.id = a.organisation_id
      WHERE o.name = $1
      ORDER BY a.created_at
      LIMIT 1`,
    [NAME],
  )
).rows;

const environmentId =
  existing.length > 0
    ? existing[0].id
    : (await createEnvironment(db, { name: NAME })).id;

const key = await createApiKey(db, { environmentId });

// STDOUT IS THE INTERFACE. A caller in a shell wants the credential and nothing
// else on the pipe, so everything a human wants to read goes to stderr and the
// key goes to stdout on its own line:
//
//   RELAY_DEMO_CREDENTIAL=$(node scripts/seed-demo-tenant.mjs)
console.error(
  existing.length > 0
    ? `reusing environment ${environmentId} (organisation "${NAME}")`
    : `created organisation "${NAME}", one application, one development environment`,
);
console.error(`environment_id ${environmentId}`);
console.log(key.credential);

process.exit(0);
