// Seed one environment with U users across C channels, for the NFR-SCL-01 measurement.
//
// The shape is forced by two platform rules, not chosen:
//   - `MAX_CONNECTIONS_PER_USER = 5`, so N connections needs at least N/5 users.
//   - a gateway's Redis SUBSCRIBE cost is per CHANNEL, not per connection, so channels
//     and connections have to vary independently or the measurement conflates them.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(REPO, "services", "api", "dist");
const client = require_(join(dist, "db", "client.js"));
const seeder = require_(join(dist, "db", "repository.js"));

const USERS = Number(process.env.SCALE_USERS ?? 2000);
const CHANNELS = Number(process.env.SCALE_CHANNELS ?? 200);

const db = client.createDb(client.createPool());
const env = await seeder.createEnvironment(db, { name: `scale-${Date.now()}` });
const key = await seeder.createApiKey(db, { environmentId: env.id });
const repo = new seeder.Repository(db, env.id);

const t0 = Date.now();
const channels = [];
for (let c = 0; c < CHANNELS; c += 1) {
  channels.push(await repo.createChannel(`scale-c-${c}`, "public", `scale ${c}`));
}
const users = [];
for (let u = 0; u < USERS; u += 1) {
  const user = await repo.createUser(`scale-u-${u}`, `Scale ${u}`);
  // Each user belongs to ONE channel, round-robin. A user in every channel would make
  // channels-per-connection meaningless: the point is to hold the two apart.
  await repo.addMember(channels[u % CHANNELS].id, user.id);
  users.push(user.external_id);
}
console.log(JSON.stringify({
  environmentId: env.id,
  credential: key.credential,
  channels: channels.map((c) => c.id),
  users,
  seededMs: Date.now() - t0,
}));
process.exit(0);
