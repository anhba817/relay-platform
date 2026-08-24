import {
  internalBackfillResponseSchema,
  internalSendResponseSchema,
  internalSessionResponseSchema,
  internalUsageReportResponseSchema,
  type InternalBackfillRequest,
  type InternalBackfillResponse,
  type InternalSendRequest,
  type InternalSendResponse,
  type InternalSessionResponse,
  type InternalUsageReportRequest,
  type InternalUsageReportResponse,
} from "@relay/protocol";

// The gateway's only road to state (chapter 2.5, ADR-05): internal HTTP to
// the api service. Not a database client — a client of the service that
// owns the database.
//
// Request and response shapes are NOT written here. They come from
// @relay/protocol's internal contract, the same schemas the api validates
// with, so the two sides cannot drift (ADR-01's payoff, applied to the
// internal hop). And responses are PARSED, not assumed: an internal caller
// has no more right to trust a payload's shape than an external one does —
// the day the api changes a field name, this fails loudly here instead of
// producing an `undefined` seq in an ack three layers away.

/** A failed internal call, carrying the status. Chapter 3.2 needs the
 * distinction: a 401 from the api means the CONNECTION'S credential is no longer
 * good, which a client can act on by reconnecting, while a 500 means we are
 * broken and it should not. `new Error("send failed")` could not tell them
 * apart, so the socket answered both the same way. */
export class ApiError extends Error {
  readonly status: number;

  /** The api's own error code and message, when it sent an envelope (chapter 3.15).
   *
   * THEY WERE THROWN AWAY UNTIL NOW, and it cost more than it looked. The socket's send
   * path forwards a 401 by hand and answers `internal_error` for everything else, so
   * every refusal the api can give a socket send — `user_banned` this chapter,
   * **`channel_archived` since this feature's archive phase** — reached the client as
   * "send failed". Chapter 3.14 built thirteen codes and one registry precisely so a
   * client could tell refusals apart, and one hop discarded all of it.
   *
   * `undefined` when the response carried no envelope: a proxy's HTML 502, a timeout, a
   * body that is not JSON. The caller then has nothing to forward and says so, which is
   * the honest answer rather than a guessed code. */
  readonly code: string | undefined;
  readonly publicMessage: string | undefined;

  constructor(
    what: string,
    status: number,
    envelope?: { code?: string; message?: string },
  ) {
    super(`${what} failed: ${status}`);
    this.name = "ApiError";
    // Declared and assigned rather than a constructor parameter property:
    // `erasableSyntaxOnly` is on everywhere except the api (ADR-15, chapter
    // 1.4), and the gateway keeps that guarantee.
    this.status = status;
    this.code = envelope?.code;
    this.publicMessage = envelope?.message;
  }
}

export interface Identity {
  environmentId: string;
  userExternalId: string;
  /** Chapter 3.2: the token the client presented at connect, carried so the
   * internal hop can FORWARD it instead of asserting who the caller is. The
   * gateway holds it; it does not verify it and holds no secret that could. */
  token: string;
}

export interface ApiClient {
  /** Chapter 3.2: present the token, be told who it belongs to and what it may
   * hear. Null means the api answered "not valid" — distinct from a throw, which
   * means it could not answer at all, and the two must not close a socket the
   * same way. */
  session(
    token: string,
  ): Promise<InternalSessionResponse | { quotaExceeded: string } | null>;
  /** Resume backfill (chapter 2.7): everything past the cursors, per
   * channel, already shaped as wire frames. */
  backfill(
    identity: Identity,
    cursors: Record<string, number>,
  ): Promise<InternalBackfillResponse["channels"]>;
  sendMessage(
    identity: Identity,
    body: InternalSendRequest,
  ): Promise<InternalSendResponse>;
  /** Chapter 3.11: the one call the gateway makes FOR ITSELF.
   *
   * Every other method on this interface takes an `Identity` and forwards the
   * token inside it. This one takes none, and the absence is the design: a usage
   * report is not a user's action, it is this process's claim about many
   * connections across many environments. It presents the platform credential
   * from `RELAY_INTERNAL_CREDENTIAL_GATEWAY` instead.
   *
   * `null` when no credential is configured — the gateway serves sockets without
   * metering rather than refusing to start, because metering may not be a
   * startup dependency (constitution III). */
  reportUsage(
    body: InternalUsageReportRequest,
  ): Promise<InternalUsageReportResponse | null>;
}

export function createApiClient(
  baseUrl: string,
  /** Chapter 3.11. Absent by default and absent in every test that does not
   * meter, which is the same safe direction the api's side takes: with nothing
   * configured, no report is ever sent and no route is ever reached. */
  serviceCredential?: string,
): ApiClient {
  // Chapter 3.2 retired two headers here. The gateway used to send
  // an environment header and a user header — values it INVENTED from a token
  // it verified with a shared development secret. It now forwards the token
  // itself and is told who the caller is (research R1). One header instead of
  // two, and the api is the only thing that decides identity.
  const headers = (identity: Identity) => ({
    "content-type": "application/json",
    authorization: `Bearer ${identity.token}`,
  });

  async function parse<T>(
    res: Response,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    what: string,
  ): Promise<T> {
    if (!res.ok) {
      // The envelope, if there is one. Read defensively: this is an error path, and a
      // body that fails to parse must not replace the api's status with a JSON
      // exception the caller cannot act on.
      let envelope: { code?: string; message?: string } | undefined;
      try {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null && "code" in body) {
          const { code, message } = body as { code?: unknown; message?: unknown };
          envelope = {
            ...(typeof code === "string" ? { code } : {}),
            ...(typeof message === "string" ? { message } : {}),
          };
        }
      } catch {
        envelope = undefined;
      }
      throw new ApiError(what, res.status, envelope);
    }
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success || parsed.data === undefined) {
      throw new Error(`${what} returned a payload the contract does not allow`);
    }
    return parsed.data;
  }

  return {
    async session(token) {
      const res = await fetch(`${baseUrl}/internal/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      });
      // 401 is an ANSWER, not a failure: the api verified the token and refused
      // it. Everything else falls through to `parse`, which throws — the api
      // being unreachable is a different event with a different close code.
      if (res.status === 401 || res.status === 403) return null;
      // Chapter 3.11. So is 402, and it is a DIFFERENT answer: the credential is
      // good and the month is spent. Without this branch it would fall into
      // `parse`, throw, and close the socket 1011 — "we are broken, retry" —
      // which is wrong about whose fault it is and wrong about whether retrying
      // helps.
      //
      // The message travels rather than the status, because what a client needs
      // is the date it resumes and only the api knows that.
      if (res.status === 402) {
        const body = (await res.json()) as { message?: string };
        return {
          quotaExceeded:
            body.message ?? "this environment's monthly quota is exhausted",
        };
      }
      return parse(res, internalSessionResponseSchema, "session");
    },
    async backfill(identity, cursors) {
      const res = await fetch(`${baseUrl}/internal/backfill`, {
        method: "POST",
        headers: headers(identity),
        body: JSON.stringify({ cursors } satisfies InternalBackfillRequest),
      });
      const body = await parse(res, internalBackfillResponseSchema, "backfill");
      return body.channels;
    },
    async reportUsage(body) {
      // No credential, no report. Not an error and not a throw: a gateway with
      // no metering configured is a gateway that serves sockets, and the caller
      // logs the absence once at boot rather than on every tick.
      if (serviceCredential === undefined) return null;
      const res = await fetch(`${baseUrl}/internal/usage/connections`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The gateway's OWN credential. Not `headers(identity)` — there is no
          // identity here, and reaching for one would mean picking a user to
          // speak for, which is exactly the assertion chapter 3.2 removed.
          authorization: `Bearer ${serviceCredential}`,
        },
        body: JSON.stringify(
          body satisfies InternalUsageReportRequest,
        ),
      });
      return parse(res, internalUsageReportResponseSchema, "usage report");
    },
    async sendMessage(identity, body) {
      const res = await fetch(`${baseUrl}/internal/messages`, {
        method: "POST",
        headers: headers(identity),
        body: JSON.stringify(body satisfies InternalSendRequest),
      });
      return parse(res, internalSendResponseSchema, "send");
    },
  };
}
