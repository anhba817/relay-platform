import type { Logger } from "@relay/service-kit";

import type { Db } from "../db/client";
import {
  drainDisableNotifications,
  organisationRecipients,
  type DisableNotificationRow,
} from "../db/repository";
import { disableNotification, type Mailer } from "./mailer";

// The notification relay (chapter 3.8, FR-018 to FR-023).
//
// THE OUTBOX A THIRD TIME, and deliberately the same shape as chapter 3.3's:
// claim undelivered rows oldest-first with `FOR UPDATE SKIP LOCKED`, do the
// side effect, mark what succeeded, and put the mark in a `finally`. A reader
// who understood the event relay understands this one, which is the argument
// for reaching for a pattern the codebase already has rather than a queue
// library it does not (constitution VII).
//
// WHAT IS DIFFERENT is that the side effect is an email, which cannot be undone
// and cannot be deduplicated by the recipient. That pushes every ambiguous case
// the same way: send once too few rather than once too many is WRONG here —
// FR-WHK-07 exists because an endpoint went quiet and nobody was told — so a
// crash between the send and the mark resends, and the chapter says so.
//
// NOT ON THE REQUEST PATH, for chapter 3.3's reason. Disabling an endpoint
// writes a row and returns; whether a mail server is reachable is this loop's
// problem. An SMTP timeout inside the dispatcher's disablement check would make
// a mail outage into a webhook outage.

/** Rows per pass. Smaller than the event relay's hundred because each row is a
 * network round trip to a mail server rather than a publish to a local broker,
 * and a batch is a transaction. */
const BATCH_SIZE = 20;

/** Slower than the event relay's 200ms, and it should be. Nothing is waiting on
 * this: FR-WHK-07 asks that the organisation be told, not that it be told within
 * the second, and a mail server polled five times a second by a service with
 * nothing to send is a service being rude to its dependencies. */
const IDLE_INTERVAL_MS = 5_000;

export interface NotificationRelay {
  start(): void;
  stop(): Promise<void>;
  /** One pass, for tests and for the walk script — the same code path `start`
   * runs, so nothing is proven about a loop only tests exercise. */
  drainOnce(): Promise<number>;
}

export function createNotificationRelay({
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
}): NotificationRelay {
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  async function deliver(row: DisableNotificationRow): Promise<void> {
    // Resolved from the ROW's organisation, not from the endpoint's current
    // owner. Chapter 3.6 denormalised that column so this lookup could not
    // follow an application that moved after the disablement (FR-022).
    const recipients = await organisationRecipients(db, row.organisationId);

    if (recipients.length === 0) {
      // A REAL BRANCH, not a defensive `if`. `humans.email` is nullable — a
      // human who signed in through a provider that returned no address has
      // none — so an organisation whose every member is unaddressable is a
      // state the schema permits and this code will meet (FR-023).
      //
      // The row is still marked delivered. There is no address to retry to, and
      // leaving it claimable would mean this relay reclaimed the same
      // undeliverable row every five seconds for ever. What replaces the email
      // is this log line: the obligation is discharged as far as it can be, and
      // the fact that it could not be met is recorded rather than swallowed.
      logger.log("error", "notifications.unaddressable", {
        organisation_id: row.organisationId,
        notification_id: row.id,
        detail:
          "webhook disablement could not be notified: no member has an email address",
      });
      return;
    }

    const mail = disableNotification({
      endpointUrl: row.endpointUrl,
      environmentName: row.environmentName,
      disabledAt: row.disabledAt,
      runStartedAt: row.runStartedAt,
      attempts: row.runAttempts,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
    });

    // Sequential, and one message per recipient rather than one message with
    // several addresses on it: a customer's colleagues' email addresses are
    // that customer's data, and putting them in a header every recipient can
    // read is a disclosure nobody asked for.
    for (const to of recipients) {
      await mailer.send(to, mail);
    }
    logger.log("info", "notifications.sent", {
      notification_id: row.id,
      recipients: recipients.length,
    });
  }

  async function drainOnce(): Promise<number> {
    return drainDisableNotifications(db, batchSize, deliver);
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const sent = await drainOnce();
        if (sent > 0) {
          // A count and an id. Never an address: a recipient list in a log line
          // is a customer's people in an operator's terminal (NFR-SEC-06).
          logger.log("info", "notifications.drained", { count: sent });
          continue;
        }
      } catch (error) {
        // A mail server that is down lands here. Rows stay claimable and the
        // next pass tries again, which is the whole reason this is a table
        // rather than a call.
        logger.log("error", "notifications.drain_failed", {
          error: String(error),
        });
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
      mailer.close();
    },
    drainOnce,
  };
}
