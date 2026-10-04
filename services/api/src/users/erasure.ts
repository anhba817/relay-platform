import {
  AnalyticalStoreError,
  createAnalyticalStore,
  type AnalyticalStore,
} from "../metering/clickhouse";

/** A DEADLINE, BECAUSE THIS ONE SERVES A PERSON. `reader.ts:243`'s value and its
 *  reason: constitution III's second clause forbids the analytical path affecting API
 *  availability, and a `fetch` with no `signal` holds the caller until the operating
 *  system gives up. The erasure's operational half has already committed by the time
 *  this runs, so the deadline costs a `not_reached` on the receipt and never a rollback. */
const CLIENT_DEADLINE_MS = 3_000;

/** What one store could do about one user, and the word is the whole receipt
 * (FR-MOD-04's *completion receipt*; `contracts/erasure.md` carries the argument). */
export type Outcome =
  | "erased"
  | "nothing_to_erase"
  | "retained_anonymous"
  | "cannot_erase"
  | "not_reached";

export interface StoreResult {
  store: string;
  outcome: Outcome;
  rows?: number;
  note?: string;
}

/** Erase a user from the analytical store, and report what each table could do.
 *
 * ## THIS FUNCTION TAKES AN `environmentId` BECAUSE NOTHING ELSE WILL GIVE IT ONE
 *
 * Six of the seven stores in the traversal are reached through `Repository`, whose
 * constructor requires an `environment_id` — constitution I's mechanism, and it means
 * nobody has to remember. **ClickHouse is the only store that class does not mediate**,
 * and it is the only one the first draft of `data-model.md` wrote unscoped. The
 * signature carries what the constructor would have.
 *
 * What an unscoped delete costs, measured on the worst id on the development lane:
 *
 *     tuan                           111 environments · 156 rows
 *       correct for one tenant                                4
 *       WRONGLY DELETED from 110 other tenants              152     97.4%
 *
 * External ids are unique per environment and not globally: 1,576 are reused across
 * environments in `users`, and in `connection_events` 23 of 54 span more than one.
 * **An unscoped delete here is not a near miss, it is mostly wrong.**
 *
 * ## AND BOTH PREDICATES ARE BOUND, WHICH IS THE OTHER HALF OF THE SAME SURFACE
 *
 * The environment is ours and the external id is the caller's, out of a URL path, up
 * to 255 characters of anything. Interpolated, `ev'il OR 1=1 --` takes the scoped
 * count from 0 to 1,081 — the whole table — because `OR` binds looser than the `AND`
 * chain the scope is written in. **The predicate analysis pass 2 added is exactly what
 * pass 4's injection defeats**, so the scope and the binding are one fix and neither
 * works alone.
 *
 * ## WHY IT REPORTS RATHER THAN THROWS
 *
 * Constitution III keeps the analytical path independent of the operational one, so a
 * ClickHouse outage must not roll back an erasure that has already destroyed a
 * person's profile, their external id and their uploads — none of which can be put
 * back. The operational half commits; this half is attempted and its failure becomes
 * `not_reached` on the receipt. Without that outcome the only honest alternative is to
 * fail the whole request, which is the coupling III names.
 *
 * Called by `UsersService.eraseUser`, after the Postgres traversal has committed. */
export async function eraseFromAnalyticalStore(
  environmentId: string,
  userExternalId: string,
  store: AnalyticalStore = createAnalyticalStore({ timeoutMs: CLIENT_DEADLINE_MS }),
): Promise<StoreResult[]> {
  const bind = { env: environmentId, uid: userExternalId };
  const scope =
    "WHERE environment_id = {env:UUID} AND user_external_id = {uid:String}";

  const results: StoreResult[] = [];

  try {
    // COUNT FIRST, BECAUSE THE DELETE RETURNS NOTHING TO COUNT. Measured: a `DELETE`
    // answers HTTP 200 with a 0-byte body, so `query`'s `string[][]` comes back empty
    // whichever verb is used. The number on the receipt has to be a separate SELECT.
    const before = await store.query(
      `SELECT count() FROM relay_analytics.connection_events ${scope}`,
      bind,
    );
    const rows = Number(before[0]?.[0] ?? 0);

    // THE LIGHTWEIGHT FORM, AND THAT IS WHAT MAKES THE VERIFICATION BELOW TRUE.
    // `ALTER TABLE … DELETE` returns with its rows still countable — 051's *a mutation
    // is not a delete* — so after it a `SELECT count()` reports an intention. This one
    // is visible to the very next statement.
    await store.query(
      `DELETE FROM relay_analytics.connection_events ${scope}`,
      bind,
    );

    const after = await store.query(
      `SELECT count() FROM relay_analytics.connection_events ${scope}`,
      bind,
    );
    const left = Number(after[0]?.[0] ?? 0);

    results.push(
      left === 0
        ? { store: "connection_events", outcome: "erased", rows }
        : {
            store: "connection_events",
            outcome: "cannot_erase",
            rows: left,
            note: "the delete returned and the rows are still there",
          },
    );
  } catch (cause) {
    // THE STATUS IS NOT READ, AND THAT IS DELIBERATE. A timeout, a refused connection
    // and a rejected statement all leave the same thing true of this receipt: nobody
    // can say whether those rows are gone. One outcome, and the operator retries.
    results.push({
      store: "connection_events",
      outcome: "not_reached",
      note:
        cause instanceof AnalyticalStoreError
          ? `the analytical store answered ${cause.status}`
          : "the analytical store did not answer",
    });
  }

  // NO ATTEMPT, AND THE TWO SILENCES ARE DIFFERENT (`contracts/erasure.md`).
  results.push({
    store: "api_requests",
    outcome: "nothing_to_erase",
    note: "this table records no user identifier",
  });
  results.push({
    store: "daily_usage",
    outcome: "retained_anonymous",
    rows: 0,
    note: "uniq sketches keyed on the internal uuid; nothing to subtract and nothing identifying",
  });

  return results;
}
