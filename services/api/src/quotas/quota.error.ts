import type { QuotaConfig } from "./config";

/** The dimensions a quota is measured in. `connection_minutes` is chapter 3.11. */
export type Dimension = keyof QuotaConfig;

/** Raised by the repository when a send would exceed a hard cap.
 *
 * NOT AN HTTP CONCERN. The repository layer does not know what status a caller
 * will map this to, and it holds the four things the message has to name:
 * which dimension, what was used, what was allowed, and which period. Turning
 * that into a `402` is the service boundary's job, and turning it into an
 * envelope is `ProtocolErrorFilter`'s — one place, not three (research R3). */
export class QuotaExceededError extends Error {
  readonly dimension: Dimension;
  readonly usage: number;
  readonly quota: number;
  readonly period: string;

  constructor(args: {
    dimension: Dimension;
    usage: number;
    quota: number;
    period: string;
  }) {
    super(
      `${args.dimension} quota exhausted: ${args.usage} of ${args.quota} for ${args.period}`,
    );
    this.name = "QuotaExceededError";
    this.dimension = args.dimension;
    this.usage = args.usage;
    this.quota = args.quota;
    this.period = args.period;
  }

  /** The date sends resume: midnight UTC on the first of the next month.
   *
   * In the message rather than in a `Retry-After` header, and that is the whole
   * argument for `402` over `429`. A client that sleeps for the header's value
   * and retries is behaving correctly for a rate limit and wrongly for a quota,
   * which will still be exhausted in an hour and in a week. */
  resumesOn(): string {
    const [y, m] = this.period.split("-").map(Number);
    const nextMonth = m === 12 ? 1 : (m ?? 1) + 1;
    const nextYear = m === 12 ? (y ?? 0) + 1 : y;
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  }

  /** The sentence a developer reads in a log at 3am. Four things in a fixed
   * order: the dimension, the figure used, the figure allowed, and when it
   * changes (contracts/quota.md §1). */
  publicMessage(): string {
    return (
      `monthly ${this.dimension === "messages" ? "message" : "active user"} ` +
      `quota exhausted: ${this.usage} of ${this.quota} for ${this.period}; ` +
      `sends resume on ${this.resumesOn()}`
    );
  }
}
