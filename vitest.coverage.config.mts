import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// Coverage, across BOTH lanes (feature 024).
//
// This config exists because constitution VI's bar cannot be measured one
// package at a time. The code it names — message ordering, idempotency, tenant
// isolation — lives in the api's repository layer, and most of it is reached
// only by integration tests. A unit-only coverage run would report a
// comfortable number about the wrong thing, which is worse than no number.
//
// So the include list is both `*.test.ts` and `*.itest.ts`, and running this
// needs the compose stores up. That is the honest cost of measuring the thing
// the constitution actually asks about.
//
// The SWC plugin is here for the same reason `services/api/vitest.config.mts`
// has it: esbuild strips decorators without emitting metadata, and Nest's DI
// would silently resolve nothing. It is harmless for the packages that use no
// decorators.
export default defineConfig({
  test: {
    // Feature 030: the global-operation guard. `globalSetup` migrates and
    // then installs the trigger once per lane; `setupFiles` sets the
    // exemption for files on the harness's list and, where the lane carries
    // bait, plants it per file. This lane gets exemption
    // handling and NO bait: it holds no reader-shape fault, and planting
    // would change its workload for no return (FR-022).
    globalSetup: ["./packages/test-harness/src/global-setup.ts"],
    setupFiles: ["./packages/test-harness/src/setup.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "packages/*/src/**/*.itest.ts",
      "services/*/src/**/*.itest.ts",
    ],
    // The e2e journey spawns real services and is excluded on purpose: it
    // measures the system, not any file's branches, and its child processes'
    // coverage is not attributable here anyway.
    exclude: ["**/node_modules/**", "packages/e2e/**"],
    // Suites in one process would share a database in ways their authors did
    // not design for — the outbox chapter's suite learned that the hard way.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "services/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.itest.ts",
        "**/dist/**",
        "packages/e2e/**",
        // Entry points and framework wiring: reached by running the service,
        // not by asserting on it. Counting them measures how much of `main.ts`
        // a test happened to touch, which is not what "business logic" means.
        "**/main.ts",
        "**/*.module.ts",
        // THE LANE'S OWN INFRASTRUCTURE IS NOT BUSINESS LOGIC. `include` is
        // `packages/*/src/**`, so the harness arrived inside the measurement the
        // moment it became a package. Its files run on every integration suite and
        // would score near the top, raising the workspace figure while saying
        // nothing about the product — the same dilution `**/*.module.ts` is
        // excluded for.
        //
        // Excluded as a directory rather than file by file, deliberately: unlike
        // the driver exemption, absorbing the next file added here is the CORRECT
        // behaviour, because the next file added here is also not business logic.
        "packages/test-harness/**",
      ],
      thresholds: {
        // Constitution VI, first clause: 70% of business logic. Set to what the
        // constitution says, not to what the code achieves — a threshold tuned
        // down to pass measures nothing. Currently met with room to spare
        // (86.55% statements, 78.07% branches at the time of writing).
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,

        // Constitution VI, second clause: ordering, idempotency and tenant
        // isolation MUST have 100% BRANCH coverage (NFR-MNT-02).
        //
        // They do not. `repository.ts` — which holds all three — measures
        // 89.51%. These per-file numbers are therefore a RATCHET pinned at
        // today's measurement, not the bar: they stop the figure sliding
        // backwards while the gap is closed, and they are deliberately not the
        // 100% the constitution asks for, because a threshold nothing can pass
        // makes CI permanently red and teaches everyone to ignore it.
        //
        // The gap is recorded in specs/024-coverage-and-ci/notes.md with the
        // uncovered branches named. Raising these to 100 is the work; this
        // feature is the instrument that made the number sayable at all.
        // THIS CHAPTER LOWERED `lines` 98 -> 97, AND THE REASON IS NOT A
        // REGRESSION. Silencing the relays lane-wide removed coverage that came
        // from a background sweep nobody asserted on: two hundred bait rows moving
        // through `claimAndPublish` while every other suite ran. A number that
        // depended on an unasserted loop racing the tests was never a measurement
        // of this file, and the honest figure is the lower one.
        //
        // The three uncovered lines are named rather than chased, because each is a
        // throw for a state the surrounding code says cannot arise:
        //
        //   118   no such environment, in a mint whose caller already resolved it
        //   724   a channel neither inserted nor readable — the row is another
        //         environment's, and the caller sees the not-found answer anyway
        //   1010  an idempotency key that conflicted while its message is missing
        //
        // Reaching any of them from a test means corrupting the database first, and
        // a test that does that is asserting on the corruption rather than on the
        // guard. Measured at 97.74; pinned at 97, one point below, for the run-to-
        // run swing this provider has (a function of forty on `session.ts` moved
        // 87.80 -> 85.36 on identical code).
        //
        // ── THE USER SURFACE RAISED BRANCHES, 85 -> 90 ────────────────────────────
        //
        // The first time this file's branch ratchet has moved UP. The chapter added
        // roughly six hundred lines here — the listing with its unread arithmetic, the
        // read position that only moves forward, bulk upsert, the deletion that keeps
        // the row, the ban — and branches measured **91.53%** against a pin of 85.
        //
        // PINNED AT 90 AND NOT 91. 91.53 clears 91 by half a point, which is inside
        // the swing this provider has shown; 90 locks in most of the gain and leaves
        // the next chapter more than a rounding error of room. A ratchet that has to
        // be lowered next chapter teaches people to lower ratchets.
        //
        // AND LINES STAY AT 97 THOUGH THEY MEASURE 98.14, for the same reason and with
        // the same arithmetic: 97.74 last chapter, 98.14 now, a 0.4 swing on code that
        // did not change in between.
        //
        // WHAT IS STILL UNCOVERED, and each is the class the note above names — a
        // throw for a state the surrounding code says cannot arise:
        //
        //   119   no such environment, in a mint whose caller already resolved it
        //   841   a channel neither inserted nor readable: the loser of an ON
        //         CONFLICT race finding no row, which needs the winner's row deleted
        //         between two statements of one call, and nothing deletes channels
        //   2109  an idempotency key that conflicted while its message is missing
        //   2270  the private-channel arm of the history read, whose OTHER arm every
        //         test takes — the one branch here that is reachable, and the chapter
        //         that gives a user a history page is where it gets its case
        //
        // The four are the same four; only their line numbers moved. Re-read at the
        // sender chapter rather than assumed, because a stale list of what is uncovered
        // is how a ratchet keeps a claim nobody has checked since it was true.
        "services/api/src/db/repository.ts": {
          // 90 -> 92 (the sender chapter). MEASURED TWICE ON THIS TREE: 92.66 both
          // times, byte-identical down to the uncovered line numbers. Two observations
          // rather than one because coverage is not reproducible run to run here —
          // `session.ts` has read 87.80 and 85.36 on identical code twenty minutes
          // apart — and a ratchet pinned to a single lucky reading is one that teaches
          // its next reader to lower it. This file did not move at all, so the headroom
          // below the pin is 0.66 rather than a swing allowance.
          //
          // The arms that moved it: the sender's `kind` read feeding two checks, the
          // promotion's has-ever-sent scan, and the kind-conflict flag that replaced a
          // third throw. Statements (96.45) and lines (98.23) also cleared their pins,
          // and are deliberately NOT raised: this chapter changed the branch structure,
          // and moving three ratchets on one chapter's evidence tightens two of them
          // against a measurement that was never their subject.
          branches: 92,
          functions: 100,
          lines: 97,
          statements: 95,
        },
        //
        // THE WEBHOOK CHAPTER RAISED THESE IN THE PUBLISHED ORDER AND CANNOT HERE, which
        // is worth one paragraph because the direction is the interesting part. There, the
        // webhook work added six operations to this file and branches fell 85.91 -> 78.22
        // — `deliveryMaterial` and `pendingDeliveryDepth` were called only by the
        // dispatcher, whose suite runs the api as a CHILD PROCESS whose coverage is not
        // attributable — and the answer was to write `webhooks/deliveries.itest.ts` rather
        // than lower the pin. This order has already run the chapters that took this file
        // to 92, so the same tests arrive against a HIGHER floor than they were written
        // for. The pin stays where the later chapters put it; what the webhook tests buy
        // here is that it does not move DOWN.
        //
        // AND THE DISABLEMENT CHAPTER RAISED THEM AGAIN IN THE PUBLISHED ORDER, 89 -> 90,
        // which this order cannot do either: the pin is already 92 and the webhook
        // chapter's battery measured 93.48. Published's account is worth keeping for its
        // shape — measured mid-chapter with the failure run written and its tests not
        // yet, that file read 96.46 statements and 88.80 branches, which is the instrument
        // saying "you added five operations and tested none of them" in the only language
        // it has. The tests were written rather than the pin lowered. Here they arrive
        // against a floor five chapters of later work already raised.
        //
        // The dispatcher's two decision-bearing files. `expand.ts`
        // decides whether a redelivered event produces a second set of webhooks
        // — constitution VI names idempotency explicitly — and `deliver.ts`
        // holds the post-then-report ordering that chooses a duplicate over a
        // silent loss. Pinned here because they measured 0% and 87.5% when the
        // service arrived, which is exactly what research R12 warned a new
        // deployable would do to a green instrument.
        //
        // MEASURED ON THIS TREE AT 1,038 TESTS ACROSS 68 FILES: `expand.ts`
        // 92.3/92.3/100/100 and `deliver.ts` 100/90.9/100/100. Both pins hold as
        // published wrote them.
        //
        // AND THE CHILD-PROCESS EFFECT IS VISIBLE IN THREE FILES NOBODY PINS, which is
        // the same measurement read from the other end. `internal/dispatch.controller.ts`
        // reads 9.09/0/20/11.11 and `webhooks/delivery-relay.ts` 28.12/25/22.22/31.03 —
        // both are exercised almost entirely by `dispatcher.itest.ts`, which runs the api
        // as a CHILD PROCESS whose coverage is not attributable to this lane. Pinning
        // them would pin the harness rather than the code, and lowering the whole file's
        // floor to match would be a ratchet describing a test topology. What was pinned
        // instead is what a suite in THIS process can reach: the repository methods those
        // two call, covered by `webhooks/deliveries.itest.ts`.
        "services/dispatcher/src/expand.ts": {
          branches: 92,
          functions: 100,
          lines: 100,
          statements: 92,
        },
        "services/dispatcher/src/deliver.ts": {
          branches: 90,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // The retry-and-disable chapter's two new files, pinned at 100 on every metric because both
        // reached it and neither has an excuse not to.
        //
        // `disable.ts` is here because constitution VI NAMES this case: it is the
        // predicate the at-most-once disablement rests on, so it is idempotency
        // logic, and NFR-MNT-02 asks for 100% branch coverage of that. It is also
        // pure — no database, no clock, no broker — which is precisely why it was
        // separated from both triggers that call it. A file with nothing to mock has
        // no reason to be partially tested.
        //
        // `analytics.ts` is here for a different reason: everything it does is
        // decide what NOT to put on a stream. Its allow-list is the mechanism
        // standing between a customer's payload and seven days of retention
        // (FR-004, SC-006), and its `catch` is what stops an analytics outage
        // becoming a delivery outage (contract invariant 4). Both are branches, and
        // an unmeasured branch here fails silently in the direction nobody checks.
        "services/api/src/webhooks/disable.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/webhooks/analytics.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // THE DEDUPLICATION CHAPTER RAISED THIS, 93 -> 95. The chapter added two pure functions
        // to this file — the live-path suppression predicate and the scoping that
        // bounds the marks — and both are fully covered.
        //
        // Not 100, and the missing branch is named rather than chased: it is
        // `if (timer)` in chapter 2.7's `withDeadline`, whose falsy arm cannot be
        // reached because a Promise executor runs synchronously and always assigns
        // the timer before the `finally` can see it. Pinning 100 here would pin a
        // number the file cannot reach without deleting a defensive check that
        // costs nothing.
        "services/gateway/src/resume.ts": {
          branches: 95,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/auth/user-token.ts": {
          branches: 96,
          functions: 100,
          lines: 100,
          statements: 96,
        },
        // CHOSEN BEFORE THE FIRST COVERAGE REPORT, not read off it (T011). The
        // requirement is that the failure path be covered: this file's whole job is to
        // swallow a publish error, log it, and open a window, and a test that only
        // checks `publish` resolved cannot tell that apart from a publisher with no
        // body. So every branch, and every function — the last of which forces
        // `close()` and the ioredis `error` listener to be tested rather than assumed.
        //
        // Without a pin this file falls to the global floor of 70, which a ten-line
        // publisher clears with its `catch` untested.
        "services/api/src/fanout/publisher.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // T011 asked for this pin or a recorded reason, and got neither for eight
        // phases. The publish guard's two branches, `!message.duplicate &&
        // message.text !== null`, are FR-007's entire mechanism and were sitting under
        // the global floor of 70.
        //
        // The FR-007 test moved this file by covering the `duplicate` side; T058a's
        // traceability map is what noticed the clause had no test at all.
        //
        // THE REMAINING UNCOVERED BRANCH IS UNREACHABLE ON THIS ROUTE, and is left
        // rather than deleted. `message.text !== null` is only ever evaluated for a
        // NON-duplicate — the `&&` short-circuits otherwise — and a non-duplicate row
        // was just written from a request whose schema requires `text`. So the false
        // side cannot be reached from here. The ratchet has removed unreachable code
        // three times in this repository; this one stays, because `messageSchema` types
        // `text` as non-nullable and a null would publish a frame the delivery side
        // drops silently. A guard against a state the type system forbids is cheap; the
        // alternative is a silent drop.
        //
        // THIS CHAPTER MOVED THIS FILE IN BOTH DIRECTIONS, and the LINES number is the one
        // that had to come down. The chapter added two routes to it — an edit and a
        // deletion, each resolving a caller, each publishing — against inherited pins of
        // 96 statements / 87 branches / 100 functions / 100 lines.
        //
        // MEASURED, WITH THE DELETIONS BELOW ALREADY MADE AND THE NARROWING TEST HELD
        // BACK: **91.83 / 85.71 / 100 / 93.75**, three uncovered statements at lines 297,
        // 303 and 401. Statements and lines both red.
        //
        // WHAT WAS TESTED, and it was the largest part: every one of those routes throws a
        // 400 when the token's subject has no user row, and nothing exercised it. The send
        // path had had that test since the channel-control chapter; the two new routes and
        // the history route beside them did not. **One test covering all three is worth
        // +6.12 statements, +7.14 branches and +4.16 lines**, and it clears 303 and 401 —
        // measured by skipping that one test and running the battery again, rather than by
        // reasoning about which lines it touches.
        //
        // WHAT WAS REMOVED RATHER THAN TESTED, which is the ratchet's preferred outcome
        // and the fifth time it has produced one:
        //
        //   - `deleted.user ?? "unknown"` on the deletion frame. `deleteMessage` refuses
        //     a senderless row (FR-018) before it can return, so the arm was
        //     unreachable — AND the value it would have produced was a lie: the word
        //     "unknown" on the wire as somebody's name. The narrowing moved to the
        //     repository, where the foreign-key argument for it lives.
        //   - Three copies of `req.requestId ?? "unknown"` and
        //     `req.principal?.environmentId ?? "unknown"`, one per publish site, which is
        //     six uncovered arms for two distinct ones. `publishContext(req)` is one
        //     function called three times. The fallbacks stay — a log line saying
        //     `unknown` is findable where one saying `undefined` reads like a broken
        //     logger — but the count stops growing with every route that publishes.
        //
        // FINAL: **97.95 / 92.85 / 100 / 97.91**. Branches finished ABOVE the 87 this
        // chapter inherited, so that pin goes UP to 92 — 0.85 of headroom, which is the
        // margin `repository.ts` above was pinned with (92 against a measured 92.66) and
        // for the same reason: a floor at the reading itself goes red on the next run for
        // no change to the code.
        //
        // AND `repository.ts` MOVED UP RATHER THAN DOWN, which is worth one line because
        // it is the file this chapter added the most code to: 92.66 when the sender chapter
        // pinned it, **92.97 measured here**, with four routes' worth of new methods in
        // between. Its pin is left at 92 — the headroom widened on its own, and a ratchet
        // that follows every upward reading is a ratchet somebody has to lower later.
        //
        // LINES DROP FROM 100 TO 97, and the one statement still uncovered is named: line
        // 297, the narrowing throw in `edit`, which fires when a request reaches that
        // handler with no user subject. `@Accepts("user")` on the method means the guard
        // has already refused every credential that could produce it, so it is unreachable
        // while that decorator is there — and it is there to be loud if somebody removes
        // it. A `!` would restore 100% by moving the assumption somewhere a decorator
        // change cannot invalidate, which is the trade this file declines to make.
        "services/api/src/messages/messages.controller.ts": {
          branches: 92,
          functions: 100,
          lines: 97,
          statements: 97,
        },

        // The attachment shape and the REST door's schemas, both at 100 on
        // all four metrics — which is why neither appears in the text reporter's table
        // and why this pin was written from `coverage-summary.json` instead. Measured on
        // this tree at 945 tests across 62 files: 100/100/100/100 for both.
        //
        // AND THE TWO FILES THIS CHAPTER ADDED THE MOST CODE TO DID NOT MOVE THEIR PINS.
        // `messages.controller.ts` reads 97.95/92.85/100/97.91 — byte-identical to the
        // revisions chapter's reading, on a file this chapter widened — and
        // `repository.ts`'s branches went 92.66 (sender chapter) to 92.97 (revisions) to
        // **93.35** here, still above the 92 it is pinned at. Three chapters of upward
        // drift and no pin edit is the ratchet working, not the ratchet asleep.
        //
        // `attachments.ts` holds FR-MSG-11's whole contract: the two arms, the scheme
        // allowlist, the ten-item bound, and the pair rule all three send doors call. A
        // later chapter that adds an arm and no test turns this red, which is the job.
        //
        // AND A MEASURED CAVEAT ON THE BRANCH NUMBER, because 100 here means less than it
        // reads. v8 records a `binary-expr` arm as covered when the OPERAND WAS
        // EVALUATED, not when it went both ways: `typeof value.text === "string" &&
        // value.text.length > 0` measures `[7, 7]`, and the `typeof` check has never once
        // been false — no schema that calls the refinement declares `text` as anything
        // but `z.string()`. The guard stays because the signature it narrows is
        // deliberately `string | null | undefined` (see the comment on
        // `refineTextAndAttachments`), so the compiler requires it. **A file at 100%
        // branches is not a file whose every arm has run.**
        "packages/protocol/src/attachments.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // The REST door, pinned for the first time because the attachments chapter is the first to
        // find a defect in it: `editMessageBodySchema.text` was
        // `sendMessageBodySchema.shape.text`, so relaxing the send's floor for FR-019
        // relaxed the edit's, and an edit has no attachments field to restore it. Two
        // schemas that must differ cannot share a reference at all.
        "services/api/src/messages/messages.schema.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // THE PRESENCE CHAPTER'S TWO, both at 100 on every metric, and the pin is
        // NFR-MNT-02's MUST rather than a preference: presence keys are
        // `presence:{env}:{user}`, so this is tenant-isolation code and the clause asks
        // 100% of its branches.
        //
        // `packages/protocol/src/presence.ts` reached it on the first run — two exports,
        // no clock, no client, and `presence.test.ts` covers both.
        //
        // `services/gateway/src/presence.ts` did not, and closing it is the whole
        // argument for a ratchet. Six arms had never executed:
        //
        //   the JSON.parse catch            a body that is not JSON
        //   the safeParse rejection         JSON that is not a transition
        //   the refresh re-election         the key lost under a live connection
        //   `counts.get(c) ?? 1`            unsubscribe for a channel never subscribed
        //   the no-op `deliver`             a transition with no handler registered
        //   the pending-timer clear         close() while a grace check is armed
        //
        // ONE OF THEM HAD A TEST WHOSE TITLE CLAIMED IT. "logs
        // presence.invalid_payload for a payload that is not a transition" asserted
        // `toEqual([])` — it publishes a MESSAGE on a MESSAGE subject and checks presence
        // never sees it, which is FR-029 from the other side and a good test under the
        // wrong name. Both rejection arms read zero while it was green. It is renamed;
        // the real ones publish onto `presence:{channel_id}` with a client belonging to
        // neither module.
        //
        // AND ONE BRANCH WAS DELETED RATHER THAN COVERED. The re-election's
        // `if (wonTransition(won))` guard around clearing the offline marker is reachable
        // only when two instances race the same re-election — a test that could only
        // flake. The marker is now cleared unconditionally, which is also more correct:
        // unlike `connected`, nothing publishes here, so a loser that skipped the delete
        // left a stale "somebody already said they left" standing against a user who is
        // demonstrably connected.
        "packages/protocol/src/presence.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/gateway/src/presence.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // ── THIS CHAPTER'S FOUR NEW PRODUCTION FILES ───────────────────────
        //
        // All four at 100 on every metric, and the pin is NFR-MNT-02's MUST rather
        // than a preference: membership decides who may hear what, so this is
        // tenant-isolation code and the clause asks 100% of its branches.
        //
        // THREE REACHED IT ON THE FIRST RUN, and the reason is worth keeping. The
        // phase that built the gateway module listed its arms BEFORE writing them —
        // the `JSON.parse` catch, the `safeParse` rejection, an unsubscribe for a
        // channel never subscribed, a change arriving before `onChange` is wired,
        // `close()` with a timer armed, and a construction taking both defaults —
        // and drove each with a test in that phase. The presence chapter met its equivalents
        // at close-out instead and paid for it with seven tests, a deleted branch and
        // a re-measured battery.
        //
        // `memberships.controller.ts` did NOT reach it: 28.57% statements and 0%
        // branches on the first run, for a route the gateway's suite exercises end to
        // end. That suite runs in another package, and this is where the api's
        // coverage is measured — **a route can be thoroughly tested and completely
        // uncovered**. Four tests in `internal.itest.ts` fixed the measurement, and
        // its last unreachable branch — a `principal?.kind !== "user"` throw the
        // guard makes impossible — moved into the signature's type.
        "packages/protocol/src/membership.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/membership/publisher.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/internal/memberships.controller.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/gateway/src/membership.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // `packages/protocol/src/typing.ts` reached 100 on the
        // first run — one function and no branches, which is what a subject
        // builder and a schema are.
        //
        // `services/gateway/src/typing.ts` did NOT: **97.77 / 76.92 / 92.3 /
        // 97.67**, with four arms unreached. T097 asks whether unreachable code
        // should be deleted before it asks for a test, and the answer here was no
        // — all four were reachable and nothing had reached them:
        //
        //   the url default        every test supplies a url or the env var does
        //   the `onSignal` no-op   every test wires a handler through the session
        //   `counts.get(c) ?? 0`   a SECOND subscribe for one channel
        //   `next <= 0`'s else     one of two holders releasing
        //
        // The last two are the reference count, and they are the arms that decide
        // whether a second member of a channel silently loses typing when the
        // first disconnects. A gateway cannot reach them: the session layer holds
        // one connection per socket. So they are driven against the module
        // directly, in a describe that builds `createTyping` itself.
        "packages/protocol/src/typing.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // `services/gateway/src/connections.ts` at 100 on all four,
        // and it took three deletions to get there rather than three tests. The
        // first measurement read **96.15 / 82.60 / 100 / 97.67** with four arms
        // uncovered, and three of them were arms nothing could take:
        //
        //   two `failable` wrappers in the walk   the second "could not ask" arm
        //                                         needs Redis to die BETWEEN two
        //                                         commands — merged into one
        //   `renew` re-wrapping the walk's        `full` and `unenforced` mean the
        //   outcomes                              same here as there — returned whole
        //   `instanceof Error ? … : String(…)`    `presence.ts:241` uses `String`
        //                                         alone, and the other arm is
        //                                         unreachable from any test
        //
        // The fourth was a real gap and got a real test: the `url` default and the
        // `??` inside it, neither reachable while the lane sets `RELAY_REDIS_URL`.
        // That is the ratchet removing code for the fourth time in this repository
        // rather than covering it.
        "services/gateway/src/connections.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/gateway/src/typing.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
    }),
  ],
});
