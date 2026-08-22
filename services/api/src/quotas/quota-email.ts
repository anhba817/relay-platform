import type { Mail } from "../notifications/mailer";

export interface CrossingFacts {
  /** "Fleet Ops / production" — how a dashboard would name it, never a uuid. */
  environmentName: string;
  period: string;
  dimension: string;
  threshold: number;
  quota: number;
  usageAtCrossing: number;
  /** Whether a hard cap is in force right now, which decides whether this email
   * reports a stoppage or a warning. */
  hardCapInForce: boolean;
}

const NOUN: Record<string, string> = {
  messages: "messages",
  active_users: "active users",
  // Chapter 3.11. Hyphenated, as the customer-facing name — the column is
  // `connection_minutes` and nobody reads a bill in snake case.
  connection_minutes: "connection-minutes",
};

/** What stops when THIS dimension's hard cap is reached, in the words a reader
 * needs (chapter 3.11).
 *
 * "Sends are now being refused" is right for two dimensions and wrong for the
 * third: a connection-minutes cap refuses CONNECTS, and everything the tenant
 * already has keeps working. An email that names the wrong operation sends
 * somebody looking for a fault in the half that is fine. */
const DEFAULT_STOPPAGE = "Sends are now being refused with `quota_exceeded`.";

const STOPPAGE: Record<string, string> = {
  messages: DEFAULT_STOPPAGE,
  active_users: DEFAULT_STOPPAGE,
  connection_minutes:
    "New connections are now being refused with `quota_exceeded` and close code 4008. " +
    "Connections already open stay open, and sends and history reads over REST are unaffected.",
};

/** The month, as a month. `2026-08-01` is a row key, not something to show a
 * person who wants to know which bill this is. */
function monthName(period: string): string {
  const [y, m] = period.split("-");
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[Number(m) - 1] ?? m} ${y}`;
}

function resumesOn(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const nextMonth = m === 12 ? 1 : (m ?? 1) + 1;
  const nextYear = m === 12 ? (y ?? 0) + 1 : y;
  return `${monthName(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`)}`;
}

/** What an organisation's admins are told when usage crosses a threshold
 * (chapter 3.10, FR-RTL-07).
 *
 * NO SECRET, NO KEY, NO MESSAGE TEXT. Chapter 3.9 established that this is
 * verified by reading what the mail server received rather than by asserting on
 * the call, and the same test shape applies here.
 *
 * AT 100% WITH NO HARD CAP, IT SAYS NOTHING WAS REFUSED. An email that threatens
 * a suspension which will not happen is worse than no email — it teaches the
 * reader that the warnings are noise, which is the one thing a warning cannot
 * afford. */
export function quotaThreshold(facts: CrossingFacts): Mail {
  const noun = NOUN[facts.dimension] ?? facts.dimension;
  const subject =
    `Relay: ${facts.environmentName} has used ${facts.threshold}% of its ` +
    `monthly ${noun} quota`;

  const consequence =
    facts.threshold < 100
      ? "Nothing has been refused. This is a warning so the month does not end in a surprise."
      : facts.hardCapInForce
        ? `${STOPPAGE[facts.dimension] ?? DEFAULT_STOPPAGE} They resume in ${resumesOn(facts.period)}, or as soon as the quota is raised.`
        : "Nothing has been refused: this environment has no hard cap, only the threshold you asked to be told about.";

  const text = [
    `${facts.environmentName} has used ${facts.usageAtCrossing} of ${facts.quota} ${noun} for ${monthName(facts.period)} — ${facts.threshold}%.`,
    "",
    consequence,
    "",
    "Usage resets at the start of the next calendar month.",
  ].join("\n");

  return { subject, text };
}
