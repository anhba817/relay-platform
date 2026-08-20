import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { recordAttemptOutcome } from "../db/repository";
import { createMailer } from "./mailer";
import { createNotificationRelay } from "./notification-relay";

// The transport chapter 3.6 deferred, against a real mail server (chapter 3.8,
// FR-WHK-07 to FR-WHK-05).
//
// EVERY ASSERTION READS WHAT MAILPIT RECEIVED, never what the sender passed.
// FR-WHK-07 is a claim about the contents of an email, and a stub records the same
// object the assertion would be reading — so a mailer that put a secret in a
// header the stub does not model would pass. The only artefact that can settle
// it is the message a server actually took delivery of.
//
//   docker compose up -d --wait postgres mailpit
//   RELAY_POSTGRES_PORT=… RELAY_MAILPIT_HTTP_PORT=… RELAY_MAILPIT_SMTP_PORT=… \
//     RELAY_SMTP_URL=smtp://localhost:11025 RELAY_MAILPIT_URL=http://localhost:18025 \
//     pnpm --filter @relay/api test:integration src/notifications
//
// A NOTE ON THE INBOX. Mailpit is one shared inbox for the whole lane, so every
// assertion here filters by a per-test recipient address rather than reading
// "the latest message" — the mistake that makes a suite pass alone and fail
// beside another.

const mailpit = process.env["RELAY_MAILPIT_URL"] ?? "http://localhost:8025";

interface Received {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/** What Mailpit holds for one address. Polled, because SMTP acceptance and the
 * message becoming readable over the HTTP API are two events. */
async function inbox(
  address: string,
  expected = 1,
  timeoutMs = 10_000,
): Promise<Received[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    );
    const body = (await res.json()) as { messages: Received[] };
    if (body.messages.length >= expected || Date.now() > deadline) {
      return body.messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Nothing arrived, and nothing is going to. A bounded wait rather than an
 * immediate read: SMTP acceptance and the message becoming searchable are two
 * events, so an instant "it is empty" would pass for the wrong reason. One
 * second, because the positive cases in this file all land inside 200ms. */
async function stillEmpty(address: string): Promise<Received[]> {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return inbox(address, 1, 0);
}

/** One message, in full — the API's summary omits the body. */
async function bodyOf(id: string): Promise<string> {
  const res = await fetch(`${mailpit}/api/v1/message/${id}`);
  const body = (await res.json()) as { Text: string; Subject: string };
  return `${body.Subject}\n${body.Text}`;
}

describe("the disablement notification, end to end", () => {
  let db: Db;
  let pool: ReturnType<typeof createPool>;
  const silent = createLogger("notifications-itest", () => {});

  /** An organisation whose members have the addresses this test wants, an
   * application, an environment and a disabled-ready endpoint. Everything is
   * minted per test: one shared fixture would make "two emails" and "one email"
   * assertions read each other's rows. */
  const seed = async (addresses: (string | null)[]) => {
    const organisationId = randomUUID();
    const applicationId = randomUUID();
    const environmentId = randomUUID();
    const endpointId = randomUUID();
    const name = `notif-${randomUUID().slice(0, 8)}`;

    await pool.query(
      "INSERT INTO organisations (id, name) VALUES ($1, $2)",
      [organisationId, name],
    );
    for (const [index, address] of addresses.entries()) {
      const humanId = randomUUID();
      await pool.query(
        "INSERT INTO humans (id, provider, provider_account_id, email) " +
          "VALUES ($1, 'github', $2, $3)",
        [humanId, `${name}-${index}`, address],
      );
      await pool.query(
        "INSERT INTO memberships (organisation_id, human_id, role) " +
          "VALUES ($1, $2, 'owner')",
        [organisationId, humanId],
      );
    }
    await pool.query(
      "INSERT INTO applications (id, organisation_id, name) VALUES ($1, $2, $3)",
      [applicationId, organisationId, name],
    );
    await pool.query(
      "INSERT INTO environments (id, application_id, kind, signing_secret) " +
        "VALUES ($1, $2, 'development', $3)",
      [environmentId, applicationId, `sk_${randomUUID()}`],
    );
    await pool.query(
      "INSERT INTO webhook_endpoints (id, environment_id, url, event_types, " +
        "secret_ciphertext, enabled, failure_run_started_at, failure_run_attempts) " +
        "VALUES ($1, $2, $3, '[\"message.created\"]'::jsonb, $4, true, " +
        "now() - interval '2 hours', 25)",
      [
        endpointId,
        environmentId,
        `https://hooks.${name}.example/relay`,
        "not-a-real-ciphertext",
      ],
    );
    return { organisationId, environmentId, endpointId, name };
  };

  /** Drive the REAL disablement path, through the ON-OUTCOME door rather than the
   * sweep. The row under test has to be the row the product writes — a suite that
   * inserted its own notifications would prove the relay reads a table and nothing
   * about whether anything fills it.
   *
   * NOT `sweepDisabledEndpoints`, which is what this used first. That function is
   * GLOBAL: it disables the hundred oldest eligible endpoints in the database,
   * belonging to anybody. Run from here it reached into
   * `deliveries.itest.ts`'s fixture and disabled the endpoint whose whole test is
   * that the sweep disables it — so that suite failed beside this one and passed
   * alone. The sixth instance of this chapter's recurring fault, and the first one
   * this chapter CAUSED rather than found (research R46).
   *
   * `recordAttemptOutcome` is scoped to one delivery. The seed leaves the endpoint
   * one failure short of the floor, so a single failed outcome trips the same
   * `disableEndpoint` the sweep would have, writing the same notification row. */
  const disable = async (endpointId: string, environmentId: string) => {
    const deliveryId = randomUUID();
    await pool.query(
      "INSERT INTO webhook_deliveries (id, environment_id, endpoint_id, event_id, " +
        "payload, attempt, state, next_attempt_at) " +
        "VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 'pending', now())",
      [deliveryId, environmentId, endpointId, randomUUID()],
    );
    await recordAttemptOutcome(db, {
      deliveryId,
      attempt: 1,
      status: 503,
      error: "down",
      latencyMs: 5,
    });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM webhook_disable_notifications " +
        "WHERE endpoint_id = $1",
      [endpointId],
    );
    return (rows as { n: number }[])[0]!.n;
  };

  /** Is THIS endpoint's notification still claimable?
   *
   * Asked of one row, never of the batch's return value. `drainDisableNotifications`
   * is global and the integration lane runs files in parallel, so another suite's
   * disablement can be claimed by this test's relay between two of its own lines —
   * which is precisely the "local facts about a global operation" fault chapter
   * 3.7's baseline found in four suites, and which this file walked into on its
   * first full-lane run. */
  const undelivered = async (endpointId: string): Promise<boolean> => {
    const { rows } = await pool.query(
      "SELECT delivered_at FROM webhook_disable_notifications " +
        "WHERE endpoint_id = $1 ORDER BY disabled_at DESC LIMIT 1",
      [endpointId],
    );
    return (rows as { delivered_at: Date | null }[])[0]?.delivered_at === null;
  };

  const relay = () =>
    createNotificationRelay({
      db,
      mailer: createMailer(),
      logger: silent,
      batchSize: 10_000,
    });

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    db = createDb(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Drain whatever earlier tests in this file left claimable, so each test's
    // count is about its own rows. `drainDisableNotifications` is global and
    // oldest-first — chapter 3.7's baseline found four suites broken by
    // forgetting that about a global operation.
    const r = relay();
    await r.drainOnce();
    await r.stop();
  });

  it("sends what the organisation needs, and Mailpit confirms the contents (FR-WHK-07)", async () => {
    const address = `owner-${randomUUID().slice(0, 8)}@example.test`;
    const { name, endpointId, environmentId } = await seed([address]);
    expect(await disable(endpointId, environmentId)).toBeGreaterThan(0);

    const r = relay();
    expect(await r.drainOnce()).toBeGreaterThan(0);
    await r.stop();

    const [message] = await inbox(address);
    expect(message).toBeDefined();
    const whole = await bodyOf(message!.ID);

    expect(whole).toContain(`hooks.${name}.example`);
    expect(whole.toLowerCase()).toContain("re-enable");

    // The scan, on the RECEIVED message — headers, encoding and all. This is
    // the assertion the container exists for.
    for (const pattern of [
      /rk_(live|test|svc)_/i,
      /whsec_/i,
      /eyJ[A-Za-z0-9_-]{10,}/,
      /\bsecret\b\s*[:=]/i,
      /\bpassword\b\s*[:=]/i,
      /\btoken\b\s*[:=]/i,
    ]) {
      expect(whole).not.toMatch(pattern);
    }
  });

  it("sets delivered_at only AFTER the send returns (FR-WHK-07)", async () => {
    const address = `fail-${randomUUID().slice(0, 8)}@example.test`;
    const { endpointId, environmentId } = await seed([address]);
    await disable(endpointId, environmentId);

    // A mailer pointed at a port that answers nothing. The send throws, the
    // batch aborts, and the row must still be claimable — a notification marked
    // delivered because the code reached the marking line is the failure
    // FR-WHK-07 exists to prevent.
    const broken = createNotificationRelay({
      db,
      mailer: createMailer("smtp://127.0.0.1:1"),
      logger: silent,
      batchSize: 10_000,
    });
    // No throw: a send that fails is one row's problem. And THIS row is still
    // claimable — asked of the row rather than of the batch count, which counts
    // whatever else the lane happened to leave claimable.
    await broken.drainOnce();
    await broken.stop();
    expect(await undelivered(endpointId)).toBe(true);
    expect(await stillEmpty(address)).toHaveLength(0);

    // And the same row goes out on the next pass, with a mailer that works.
    const working = relay();
    expect(await working.drainOnce()).toBeGreaterThan(0);
    await working.stop();
    expect(await inbox(address)).toHaveLength(1);
  });

  it("does not send a delivered row twice (FR-WHK-07)", async () => {
    const address = `once-${randomUUID().slice(0, 8)}@example.test`;
    const { endpointId, environmentId } = await seed([address]);
    await disable(endpointId, environmentId);

    const first = relay();
    await first.drainOnce();
    await first.stop();
    expect(await inbox(address)).toHaveLength(1);

    const second = relay();
    await second.drainOnce();
    await second.stop();
    // Still one. `delivered_at IS NULL` is the whole of the deduplication, which
    // is why this needed no new column.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await inbox(address, 1, 0)).toHaveLength(1);
  });

  it("sends twice for an endpoint disabled, re-enabled and disabled again", async () => {
    // Two outages are two things to be told about. Nothing collapses them, and
    // the row that records the first must not suppress the second — the spec's
    // edge case, and the reason `delivered_at` is per row rather than per
    // endpoint.
    const address = `flap-${randomUUID().slice(0, 8)}@example.test`;
    const { endpointId, environmentId } = await seed([address]);
    await disable(endpointId, environmentId);
    const first = relay();
    await first.drainOnce();
    await first.stop();

    // The customer fixes it and switches it back on…
    await pool.query(
      "UPDATE webhook_endpoints SET enabled = true, disabled_at = NULL, " +
        "disabled_reason = NULL, failure_run_started_at = now() - interval '2 hours', " +
        "failure_run_attempts = 25 WHERE id = $1",
      [endpointId],
    );
    // …and it fails again.
    await disable(endpointId, environmentId);
    const second = relay();
    expect(await second.drainOnce()).toBeGreaterThan(0);
    await second.stop();

    expect(await inbox(address, 2)).toHaveLength(2);
  });

  it("handles an organisation nobody can be written to (FR-WHK-07)", async () => {
    // `humans.email` is nullable, so this is a state the schema permits rather
    // than a defensive `if`. The row is marked delivered — there is no address
    // to retry to, and leaving it claimable would mean reclaiming the same
    // undeliverable row every five seconds for ever — and the failure to notify
    // is logged rather than swallowed.
    const lines: string[] = [];
    const capturing = createLogger("notifications-itest", (line) => {
      lines.push(line);
    });
    const { endpointId, environmentId } = await seed([null, null]);
    await disable(endpointId, environmentId);

    const r = createNotificationRelay({
      db,
      mailer: createMailer(),
      logger: capturing,
      batchSize: 10_000,
    });
    expect(await r.drainOnce()).toBeGreaterThan(0);
    await r.stop();

    expect(lines.join("\n")).toContain("notifications.unaddressable");
    // Marked, so the next pass does not reclaim it — asked of the row, because
    // the batch count belongs to the whole lane.
    expect(await undelivered(endpointId)).toBe(false);
  });

  it("sends to EVERY member with an address, one message each", async () => {
    // One message per recipient, not one message with several addresses on it: a
    // customer's colleagues' addresses are that customer's data, and a `To`
    // header every recipient can read is a disclosure nobody asked for.
    const tag = randomUUID().slice(0, 8);
    const one = `a-${tag}@example.test`;
    const two = `b-${tag}@example.test`;
    const { endpointId, environmentId } = await seed([one, null, two]);
    await disable(endpointId, environmentId);

    const r = relay();
    await r.drainOnce();
    await r.stop();

    for (const address of [one, two]) {
      const messages = await inbox(address);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.To.map((t) => t.Address)).toEqual([address]);
    }
  });

  it("does not take anything else down with it when the mail server is gone (FR-WHK-05)", async () => {
    // The blast radius, checked rather than asserted in prose. A mail server is
    // the least reliable dependency in this system and the least important, and
    // an outage in it must not reach a customer — not message delivery, not the
    // API, not webhook dispatch. This is why the transport is a table and a loop
    // rather than a call inside the disablement path: `sweepDisabledEndpoints`
    // writes a row and returns, and whether anybody can be emailed is somebody
    // else's problem entirely.
    const address = `outage-${randomUUID().slice(0, 8)}@example.test`;
    const { endpointId, environmentId } = await seed([address]);

    // Disablement itself, with no mail server in the picture at all.
    expect(await disable(endpointId, environmentId)).toBeGreaterThan(0);
    const [row] = (
      await pool.query(
        "SELECT delivered_at FROM webhook_disable_notifications " +
          "WHERE endpoint_id = $1",
        [endpointId],
      )
    ).rows as { delivered_at: Date | null }[];
    expect(row).toBeDefined();
    expect(row!.delivered_at).toBeNull();

    // The relay, pointed at nothing. Nothing throws, and this row is untouched.
    const broken = createNotificationRelay({
      db,
      mailer: createMailer("smtp://127.0.0.1:1"),
      logger: silent,
      batchSize: 10_000,
    });
    await broken.drainOnce();
    await broken.stop();
    expect(await undelivered(endpointId)).toBe(true);

    // Everything else still works: a second endpoint disables normally while the
    // mail server is down, because nothing on that path talks to it.
    const other = await seed([`other-${randomUUID().slice(0, 8)}@example.test`]);
    expect(
      await disable(other.endpointId, other.environmentId),
    ).toBeGreaterThan(0);
    const rows = (
      await pool.query(
        "SELECT enabled FROM webhook_endpoints WHERE id = $1",
        [other.endpointId],
      )
    ).rows as { enabled: boolean }[];
    expect(rows[0]!.enabled).toBe(false);
  });

  it("does not let ONE undeliverable row block every row behind it", async () => {
    // The failure per-row isolation exists to prevent, and it is permanent
    // rather than transient: rows are claimed oldest-first, so a row that always
    // throws is always claimed first. Abort the batch on it and nothing behind
    // it is ever delivered — one address a mail server refuses, and the whole
    // notification queue is dead.
    //
    // The bad address here is one Mailpit rejects at RCPT time. Its own
    // behaviour, not a stub's: this is the shape of the thing in production.
    const tag = randomUUID().slice(0, 8);
    const bad = await seed(["not a valid address at all"]);
    await disable(bad.endpointId, bad.environmentId);
    const good = `behind-${tag}@example.test`;
    const ok = await seed([good]);
    await disable(ok.endpointId, ok.environmentId);

    const r = relay();
    // The good one goes out. The bad one does not, and does not take it down.
    expect(await r.drainOnce()).toBeGreaterThan(0);
    await r.stop();
    expect(await inbox(good)).toHaveLength(1);
  });

  it("drains chapter 3.6's backlog with NO SPECIAL HANDLING (FR-WHK-07)", async () => {
    // Rows written before any transport existed are undelivered work by the
    // claim predicate's own definition. If they needed special handling the
    // shape would be wrong — so the test is that three rows written by three
    // separate disablements all go out on one ordinary pass.
    const tag = randomUUID().slice(0, 8);
    const addresses = [0, 1, 2].map((i) => `backlog-${i}-${tag}@example.test`);
    for (const address of addresses) {
      const seeded = await seed([address]);
      expect(await disable(seeded.endpointId, seeded.environmentId)).toBe(1);
    }

    const r = relay();
    expect(await r.drainOnce()).toBeGreaterThanOrEqual(3);
    await r.stop();

    for (const address of addresses) {
      expect(await inbox(address)).toHaveLength(1);
    }
  });
});
