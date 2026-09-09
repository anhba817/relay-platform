/** The three attacks, one per shape (NFR-SEC-09).
 *
 * THE UNIT OF ASSERTION IS A PAIR, NOT A REQUEST. Constitution I forbids revealing
 * that another tenant's data exists, so the correct answer to a foreign identifier is
 * whatever the platform says about an identifier that exists NOWHERE — and a single
 * response cannot show that. Every attack here issues both and compares them.
 *
 * A suite asserting `404` instead would be wrong in three ways at once. It would
 * freeze today's status choices into a test, so a considered change to a status breaks
 * a security suite for no security reason. It would say nothing about the body. And it
 * would PASS AN ENDPOINT THAT LEAKS THROUGH ITS PROSE — an error message that echoes
 * the identifier back makes the foreign answer differ from the absent one while both
 * are 404, which is exactly the leak constitution I is about.
 *
 * So status and body are compared — and ONE FIELD IS EXCLUDED, which the paragraph
 * this replaces asked the next chapter to argue for. It said: *"There is nothing to
 * exclude from the comparison yet … when a per-request field joins it, the chapter
 * that adds it owns the decision to drop it here — and it will have to argue that the
 * field reveals nothing about the resource."*
 *
 * THE ARGUMENT. `request_id` is minted per request, so two requests never carry the
 * same one and a whole-body comparison of any two answers fails for a reason that has
 * nothing to do with tenancy. It is also the one field in the envelope that is not
 * derived from the resource at all: `code`, `message` and `docs_url` are answers about
 * what was asked for, and the id is an answer about the asking. Dropping it removes no
 * leak, because there is nothing in it to leak.
 *
 * AND THE INSTRUCTION IS WHY THIS WAS ONE LINE RATHER THAN A DEBUGGING SESSION. The
 * field's arrival turned twenty-two attacks and one channel-surface test red at once,
 * every one of them with two identical bodies and two different ids. The file that
 * broke had already written down what to do about it, in the place the reader of the
 * failure would land. */

import { withoutRequestId } from "./compare";

export interface AttackRequest {
  method: string;
  /** Path with identifiers already substituted — `/v1/channels/<uuid>/messages`. */
  path: string;
  body?: unknown;
}

export interface Answer {
  status: number;
  body: unknown;
}

/** What an attack found. `differences` is empty when the pair is indistinguishable;
 * when it is not, it says WHAT differed, because "expected true to be false" sends a
 * reader back to the source and a named difference does not. */
export interface Verdict {
  differences: string[];
  foreign: Answer;
  absent: Answer;
}

/** EXPORTED FOR THE ATTACK NO PAIR CAN EXPRESS. Every helper below forges BOTH
 * identifiers, which a nested route can satisfy while checking only the outer one — so
 * the revisions chapter's three routes are also attacked with the attacker's OWN
 * channel and the victim's message id, and that request is neither a pair nor a list.
 * One caller, one reason, rather than a fourth helper for a single shape. */
export async function send(
  baseUrl: string,
  credential: string,
  req: AttackRequest,
): Promise<Answer> {
  const res = await fetch(`${baseUrl}${req.path}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(req.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    /* a non-JSON body is itself the answer, and comparing it verbatim is correct */
  }
  return { status: res.status, body };
}

/** Exported so a unit test can drive it. THE ARM THAT REPORTS A DIFFERENCE NEVER
 * EXECUTES IN A HEALTHY LANE — every attack in the gauntlet compares equal — so the one
 * branch that matters here is the one a passing suite cannot reach. Same shape as
 * `classifyRow`: an instrument that has never fired is an untested instrument. */
export function comparePair(foreign: Answer, absent: Answer): string[] {
  const differences: string[] = [];
  if (foreign.status !== absent.status) {
    differences.push(`status ${foreign.status} (foreign) vs ${absent.status} (absent)`);
  }
  const f = JSON.stringify(withoutRequestId(foreign.body));
  const a = JSON.stringify(withoutRequestId(absent.body));
  // REPORTED WITHOUT THE ID TOO, not merely compared without it. A message that
  // printed the raw bodies would show two ids differing on every real failure and
  // send the reader after the field this function has just decided to ignore.
  if (f !== a) differences.push(`body ${f} (foreign) vs ${a} (absent)`);
  return differences;
}

/** A read of another tenant's resource must answer as a read of nothing. */
/** A list's correct answer to "nothing of yours here" is an EMPTY RESULT, and that
 * is why it needs a shape of its own.
 *
 * Every other attack here asserts a PAIR: the foreign identifier and one that exists
 * nowhere must be indistinguishable. A listing breaks that, because the two are not
 * supposed to be indistinguishable. `GET /v1/users/:externalId/channels` names the
 * user in the path, so a foreign user id is a 404 — correctly — while a user who
 * exists and owns nothing is a 200 with no rows. Comparing those two says nothing.
 *
 * What has to be true instead is narrower and harder: **no row belonging to another
 * environment appears in any 200.** A status code cannot express that, so the verdict
 * carries the rows and the identifiers that leaked into them.
 */
export interface ListVerdict {
  status: number;
  /** How many rows came back, however the endpoint chose to wrap them. */
  count: number;
  /** Any returned identifier that belongs to the other tenant. */
  leaked: string[];
  body: unknown;
}

/** THE ROWS IN A LIST RESPONSE, whatever shape it came in.
 *
 * Two shapes because the platform has one and a future route may have the other: a
 * paginated route answers `{ data: [...] }` and a bare route answers an array.
 * Exported and pure because only ONE arm can execute against the routes that exist
 * today, and a count of zero from an unrecognised shape reads exactly like a count of
 * zero from a correctly-scoped list — which is the one answer this suite must never
 * confuse with success. `listAttack` therefore asserts the shape was recognised
 * rather than trusting the count. */
export function rowsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const data = (body as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data;
  return [];
}

export async function listAttack(
  baseUrl: string,
  credential: string,
  req: AttackRequest,
  foreignIds: readonly string[],
): Promise<ListVerdict> {
  const answer = await send(baseUrl, credential, req);
  const rows = rowsOf(answer.body);
  // SEARCHED IN THE SERIALISED BODY, not in the parsed rows. A leaked identifier can
  // arrive somewhere the row shape does not reach — a cursor, an embedded object, an
  // error message that echoes what was asked for — and the property is that the id
  // does not appear AT ALL.
  const serialised = JSON.stringify(answer.body ?? "");
  return {
    status: answer.status,
    count: rows.length,
    leaked: foreignIds.filter((id) => serialised.includes(id)),
    body: answer.body,
  };
}

export async function readAttack(
  baseUrl: string,
  credential: string,
  foreignReq: AttackRequest,
  absentReq: AttackRequest,
): Promise<Verdict> {
  const foreign = await send(baseUrl, credential, foreignReq);
  const absent = await send(baseUrl, credential, absentReq);
  return { differences: comparePair(foreign, absent), foreign, absent };
}

/** A write against another tenant's identifier must change nothing, and the pair must
 * still be indistinguishable.
 *
 * THE STATE READ IS THE POINT. A 404 that COMPLETED the write is the case no status
 * code reveals, and it is the one a reader should worry about. `readVictimState` is
 * supplied by the caller and goes through `Repository` methods rather than raw SQL: the
 * lint ban forbids the query engine outside `services/api/src/db`, and this suite
 * should not need an exemption to do its job. */
export async function writeAttack(
  baseUrl: string,
  credential: string,
  foreignReq: AttackRequest,
  absentReq: AttackRequest,
  readVictimState: () => Promise<unknown>,
): Promise<Verdict & { stateChanged: boolean; before: unknown; after: unknown }> {
  const before = await readVictimState();
  const foreign = await send(baseUrl, credential, foreignReq);
  const absent = await send(baseUrl, credential, absentReq);
  const after = await readVictimState();
  return {
    differences: comparePair(foreign, absent),
    foreign,
    absent,
    stateChanged: JSON.stringify(before) !== JSON.stringify(after),
    before,
    after,
  };
}

/** The shape a foreign-identifier attack cannot express.
 *
 * `POST /auth/dev-token` accepts no tenant-owned identifier, so there is nothing to
 * forge — and it is tenant-scoped all the same, because the key it accepts resolves to
 * exactly one environment. The attack is therefore ON THE CREDENTIAL: mint a token with
 * environment A's key and present it where only B's users belong. Filing this route as
 * exempt is how a route stops being attacked while looking accounted for. */
export interface CredentialVerdict {
  minted: boolean;
  /** The status the borrowed token got on the other tenant's resource. */
  crossStatus: number;
  crossBody: unknown;
}

export async function credentialAttack(
  baseUrl: string,
  attackerCredential: string,
  user: string,
  victimReq: AttackRequest,
): Promise<CredentialVerdict> {
  const mint = await fetch(`${baseUrl}/auth/dev-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${attackerCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ user }),
  });
  if (!mint.ok) {
    return { minted: false, crossStatus: mint.status, crossBody: await mint.json() };
  }
  const { token } = (await mint.json()) as { token: string };
  const answer = await send(baseUrl, token, victimReq);
  return { minted: true, crossStatus: answer.status, crossBody: answer.body };
}
