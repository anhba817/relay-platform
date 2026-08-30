import {
  ALL_CHANNELS,
  subjectForChannelMembership,
  subjectForUserMembership,
  type MembershipFabric,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
// A NAMED import, not a default: ioredis is CommonJS, the api is ESM, and without
// esModuleInterop a default import of a CJS module hands you the namespace object.
import { Redis } from "ioredis";

// The membership fabric's api half (chapter 3.20, FR-004).
//
// SHAPED ON `fanout/publisher.ts` AND NOT ON `createFanout`. Chapter 3.18 built that
// publisher against the same problems this one has — a store that may be down on a
// request path, a failure that must not fail the write, and a log line that is the
// only evidence the path was taken — and its choices are inherited with their reasons
// rather than rediscovered.
//
// WHAT IS NOT INHERITED: the down-window. `fanout/publisher.ts` opens one on failure
// so a known-dead store is not retried per message, because that path runs once per
// send at message volume. A membership change runs once per administrative action, so
// the window would be a state machine with two more arms to cover and nothing to buy
// with them. Named here because "shaped like" is otherwise a claim nobody can check.

export const DEFAULT_MEMBERSHIP_REDIS_URL = "redis://localhost:6379";

/** Nest's injection token. A string rather than the interface, because the interface
 * is a type and types do not survive to runtime. */
export const MEMBERSHIP_PUBLISHER = "MEMBERSHIP_PUBLISHER";

export interface MembershipPublisher {
  /** Publish one change. Resolves whatever happens: a membership write that
   * committed must not be undone by a fabric that is down (FR-016). */
  publish(change: MembershipFabric): Promise<void>;
  close(): Promise<void>;
}

export interface MembershipPublisherOptions {
  url?: string;
  logger: Logger;
}

export function createMembershipPublisher({
  url = process.env["RELAY_REDIS_URL"] ?? DEFAULT_MEMBERSHIP_REDIS_URL,
  logger,
}: MembershipPublisherOptions): MembershipPublisher {
  const redis = new Redis(url, {
    // Chapter 3.18's three, for its reasons: a queued command rejects as soon as the
    // connection attempt fails rather than waiting out a retry schedule; a connected
    // server that never answers is a different failure and only `commandTimeout`
    // catches it.
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 100,
  });
  // THE STATED REASON IS NFR-OBS-01, NOT PROCESS DEATH. `limits/store.ts:137` says a
  // missing listener kills the api; chapter 3.18 measured that against ioredis 6.0.0
  // and the process STAYS ALIVE — ioredis prints `[ioredis] Unhandled error event: …`
  // itself and continues. The accurate reason is that those lines are unstructured
  // and unbounded, which defeats NFR-OBS-01. A membership path that cannot reach
  // Redis is an expected state and should say so once, in this module's vocabulary.
  redis.on("error", (error: unknown) => {
    logger.log("error", "membership.failed", {
      op: "connection",
      error: String(error),
    });
  });

  return {
    async publish(change) {
      // TWO SUBJECTS FOR AN ADDITION, ONE FOR A REMOVAL, and the asymmetry is the
      // topology rather than an optimisation. A removal reaches both audiences on the
      // channel's subject because the removed user is still a member when it goes
      // out; an addition's new member is on an instance subscribed to nothing of that
      // channel, so the principal-addressed subject is the only way to reach them.
      //
      // A BAN IS THE THIRD CASE: `channel` is the all-channels sentinel, so there is
      // no channel subject to publish on and the user's is the whole of it.
      const subjects =
        change.channel === ALL_CHANNELS
          ? [subjectForUserMembership(change.environment, change.user)]
          : change.change === "added"
            ? [
                subjectForChannelMembership(change.channel),
                subjectForUserMembership(change.environment, change.user),
              ]
            : [subjectForChannelMembership(change.channel)];

      const body = JSON.stringify(change);
      try {
        await Promise.all(subjects.map((subject) => redis.publish(subject, body)));
      } catch (error) {
        // SWALLOWED AND LOGGED, NEVER RETHROWN. The write has committed and the
        // outbox row with it; a publish that throws here would undo a route's success
        // for a delivery the backstop exists to repair (FR-016).
        //
        // AND THE LOG LINE IS THE REQUIREMENT'S EVIDENCE (FR-015). Chapter 3.18's
        // trap against its own publisher: "the send returned 201 while Redis was
        // down" is true of a publisher that does nothing at all, so the assertion
        // that carries the requirement is this line and not the route's status.
        logger.log("error", "membership.failed", {
          op: "publish",
          channel: change.channel,
          user: change.user,
          change: change.change,
          error: String(error),
        });
        return;
      }
      // THE WORKING PATH SAYS SOMETHING TOO (FR-031). Every log requirement this
      // chapter inherited was about failure, and an operator who can only see the
      // mechanism breaking cannot tell a quiet system from a dead one.
      //
      // No message content and no token (constitution VI). A channel id and an
      // external id are what an incident needs and are what the customer's own API
      // already returns them.
      logger.log("info", "membership.published", {
        channel: change.channel,
        user: change.user,
        change: change.change,
        subjects: subjects.length,
      });
    },
    async close() {
      redis.disconnect();
    },
  };
}
