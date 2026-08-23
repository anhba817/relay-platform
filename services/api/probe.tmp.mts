import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { AppModule } from "./src/app.module.ts";
import { createDb, createPool } from "./src/db/client.ts";
import { seedTwoTenants, nowhereId } from "./src/isolation/fixtures.ts";

const db = createDb(createPool());
const t = await seedTwoTenants(db);
const app = (await Test.createTestingModule({ imports: [AppModule] }).compile())
  .createNestApplication({ logger: false });
await app.listen(0);
const url = await app.getUrl();

const hit = async (label: string, method: string, path: string, cred: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${cred}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  console.log(`${label.padEnd(34)} ${res.status}  ${text.slice(0, 96)}`);
};

console.log("--- does the attacker's credential actually work? ---");
await hit("own webhook (control)", "GET", `/v1/webhooks/${t.attacker.endpointId}`, t.attacker.credential);
console.log("--- the read pair ---");
await hit("foreign webhook", "GET", `/v1/webhooks/${t.victim.endpointId}`, t.attacker.credential);
await hit("nowhere webhook", "GET", `/v1/webhooks/${nowhereId()}`, t.attacker.credential);
console.log("--- history pair ---");
await hit("foreign history", "GET", `/v1/channels/${t.victim.channelId}/messages`, t.attacker.credential);
await hit("nowhere history", "GET", `/v1/channels/${nowhereId()}/messages`, t.attacker.credential);
console.log("--- a write pair ---");
await hit("foreign disable", "POST", `/v1/webhooks/${t.victim.endpointId}/disable`, t.attacker.credential);
await hit("nowhere disable", "POST", `/v1/webhooks/${nowhereId()}/disable`, t.attacker.credential);
console.log("--- and a bad credential, for contrast ---");
await hit("garbage credential", "GET", `/v1/webhooks/${t.victim.endpointId}`, "rk_dev_00000000000000000000000000000000_nope");
await app.close();
process.exit(0);
