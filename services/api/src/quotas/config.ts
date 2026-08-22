import { z } from "zod";

/** What `environments.quota_config` holds, and the only thing that reads it.
 *
 * THE COLUMN IS THE ONE CHAPTER 2.1 LEFT EMPTY. Declared in
 * `0000_core_tables.sql`, named in SRS §6.1, read by nothing for eighteen
 * chapters. Chapter 3.8 was offered it for rate-limit policy and refused in
 * prose — "the column is named for quotas, quotas are a later chapter". This is
 * that chapter.
 *
 * WHY A PARSER AT ALL. Chapter 3.8's limits are typed columns and need no
 * parsing; a jsonb column arrives as `unknown` and something has to turn it into
 * numbers before a cap can be compared. The alternative is a cast at each read
 * site, which is three places to get wrong instead of one.
 *
 * The schema's CHECK constraint already refuses a negative, a non-number and a
 * non-object — measured, not assumed. This is the second gate rather than the
 * only one, and it exists because the constraint cannot express "and nothing
 * else", while a parser can. */
const capsSchema = z
  .object({
    /** Absent or null: no cap. Zero: refuse everything. */
    hard: z.number().int().nonnegative().nullable().optional(),
    /** Absent or null: no alert. Alerts, never refuses. */
    soft: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const quotaConfigSchema = z
  .object({
    messages: capsSchema.optional(),
    active_users: capsSchema.optional(),
    // Chapter 3.11. This is the key the comment below predicted, and adding it
    // costs what the comment said plus three clauses in the migration's CHECK
    // rather than one line — 0010 counts the difference.
    connection_minutes: capsSchema.optional(),
  })
  // `.strict()` so a dimension nobody implemented is a parse failure rather than
  // a silently ignored cap — which is also why a new key has to land HERE and in
  // the migration together: the constraint would accept a `connection_minutes`
  // config that this parser rejected, and `capsFor` fails closed, so the cap
  // would silently become no cap.
  .strict();

export type QuotaConfig = z.infer<typeof quotaConfigSchema>;

/** One dimension's caps, resolved. `null` on either means no cap and no alert;
 * the absent state stays absent all the way to the reader rather than becoming
 * `Infinity` or `-1` somewhere up the stack. */
export interface Caps {
  hard: number | null;
  soft: number | null;
}

export const NO_CAPS: Caps = { hard: null, soft: null };

/** Read one dimension out of whatever the column held.
 *
 * FAILS CLOSED ON A PARSE ERROR — the caller gets `NO_CAPS` and a reason, and a
 * quota that cannot be read refuses nothing rather than refusing everything. A
 * malformed config is an operator's mistake, and suspending a tenant's sends
 * because their configuration is unparseable would turn a typo into an outage.
 * The caller logs; it does not swallow. */
export function capsFor(
  raw: unknown,
  dimension: keyof QuotaConfig,
): { caps: Caps; error: string | null } {
  const parsed = quotaConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { caps: NO_CAPS, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const d = parsed.data[dimension];
  return {
    caps: { hard: d?.hard ?? null, soft: d?.soft ?? null },
    error: null,
  };
}
