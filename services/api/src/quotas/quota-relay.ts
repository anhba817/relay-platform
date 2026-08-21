import type { Logger } from "@relay/service-kit";

import type { Db } from "../db/client";
import {
  drainQuotaNotifications,
  organisationRecipients,
  type QuotaNotificationRow,
} from "../db/repository";
import type { Mailer } from "../notifications/mailer";
import { quotaThreshold } from "./quota-email";

// THE OUTBOX PATTERN, A FOURTH TIME (chapter 3.10) — after 3.3's events, 3.5's
// deliveries and 3.9's disablement emails. Same shape on purpose: a table whose
// claim predicate starts null, a loop that reads it, a side effect, and no state
// shared with the request path.
//
// Four concrete tables that look alike is a pattern; one abstract table serving
// four purposes is a framework. The number is worth saying out loud, because a
// reader who has now seen it three times deserves to be told the repetition is
// deliberate rather than an oversight nobody got round to.

const BATCH_SIZE = 100;
const IDLE_INTERVAL_MS = 5_000;

export interface QuotaRelay {
  start(): void;
  stop(): Promise<void>;
  /** One pass — the same code path `start` runs, so nothing here is proven only
   * about a loop that tests never enter. */
  drainOnce(): Promise<number>;
}

export function createQuotaRelay({
  db,
  mailer,
  logger,
  batchSize = BATCH_SIZE,
  intervalMs = IDLE_INTERVAL_MS,
}: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  batchSize?: number;
  intervalMs?: number;
}): QuotaRelay {
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  async function deliver(row: QuotaNotificationRow): Promise<void> {
    const recipients = await organisationRecipients(db, row.organisationId);

    if (recipients.length === 0) {
      // The same real branch chapter 3.9 met: `humans.email` is nullable, so an
      // organisation whose every member is unaddressable is a state the schema
      // permits. The row is marked delivered because there is no address to
      // retry to, and leaving it claimable would mean reclaiming the same
      // undeliverable row every five seconds for ever. The log line is what
      // replaces the email — the obligation is discharged as far as it can be,
      // and the fact that it could not be met is recorded rather than swallowed.
      logger.log("error", "quotas.unaddressable", {
        organisation_id: row.organisationId,
        notification_id: row.id,
        detail:
          "quota threshold could not be notified: no member has an email address",
      });
      return;
    }

    const mail = quotaThreshold({
      environmentName: row.environmentName,
      period: row.period,
      dimension: row.dimension,
      threshold: row.threshold,
      quota: row.quota,
      usageAtCrossing: row.usageAtCrossing,
      hardCapInForce: row.hardCapInForce,
    });

    // One message per recipient, never one message with several addresses on
    // it: a customer's colleagues' addresses are that customer's data, and a
    // header every recipient can read is a disclosure nobody asked for.
    for (const to of recipients) {
      await mailer.send(to, mail);
    }
    logger.log("info", "quotas.notified", {
      notification_id: row.id,
      recipients: recipients.length,
    });
  }

  async function drainOnce(): Promise<number> {
    return drainQuotaNotifications(db, batchSize, deliver, (row, error) => {
      // One row's failure, one line, and the batch keeps going. A mail server
      // that is down produces one of these per claimed row and then a drain of
      // zero, which the loop treats as idle — correct, because there is nothing
      // this process can do but wait.
      logger.log("error", "quotas.send_failed", {
        notification_id: row.id,
        error: String(error),
      });
    });
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const sent = await drainOnce();
        if (sent > 0) {
          // A count and an id. Never an address (NFR-SEC-06).
          logger.log("info", "quotas.drained", { count: sent });
          continue;
        }
      } catch (error) {
        // A mail server that is down lands here. Rows stay claimable and the
        // next pass tries again, which is the whole reason this is a table
        // rather than a call.
        logger.log("error", "quotas.drain_failed", { error: String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      await loop;
    },
    drainOnce,
  };
}
