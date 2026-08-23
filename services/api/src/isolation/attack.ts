import { withoutRequestId } from "./compare";

/** The four attacks, one per shape (chapter 3.12, NFR-SEC-09).
 *
 * THE UNIT OF ASSERTION IS A PAIR, not a request. Constitution I forbids revealing
 * that another tenant's data exists, so the correct answer to a foreign identifier
 * is whatever the platform says about an identifier that exists nowhere — and a
 * single response cannot show that. Every attack here issues both and compares.
 *
 * A suite asserting `404` instead would be wrong about the list shape, would freeze
 * today's status choices into a test, and would pass an endpoint that leaks through
 * its prose: `messages.service.ts` keeps a CONSTANT message for exactly that reason,
 * because echoing the id back makes the foreign answer differ from the absent one.
 * So status, code and whole body are compared, minus the one field that reveals
 * nothing (research R3). */

export interface AttackRequest {
  method: string;
  /** Path with identifiers already substituted — `/v1/webhooks/<uuid>`. */
  path: string;
  body?: unknown;
}

export interface Answer {
  status: number;
  body: unknown;
}

/** What an attack found. `differences` is empty when the pair is indistinguishable;
 * when it is not, it says what differed, because "expected true to be false" sends
 * a reader back to the source and a named difference does not. */
export interface Verdict {
  differences: string[];
  foreign: Answer;
  absent: Answer;
}

async function send(baseUrl: string, credential: string, req: AttackRequest): Promise<Answer> {
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

/** Exported for `attack.test.ts`. The arm that reports a DIFFERENCE never
 * executes in a healthy lane — every attack in the gauntlet compares equal — so
 * the one branch that matters here is the one a passing suite cannot reach. It is
 * driven with made-up answers instead (chapter 3.12's Phase 7 argument, one layer
 * down: an instrument that has never fired is untested). */
export function comparePair(foreign: Answer, absent: Answer): string[] {
  const differences: string[] = [];
  if (foreign.status !== absent.status) {
    differences.push(`status ${foreign.status} (foreign) vs ${absent.status} (absent)`);
  }
  const f = withoutRequestId(foreign.body);
  const a = withoutRequestId(absent.body);
  if (JSON.stringify(f) !== JSON.stringify(a)) {
    differences.push(`body ${JSON.stringify(f)} (foreign) vs ${JSON.stringify(a)} (absent)`);
  }
  return differences;
}

/** T023. A read of another tenant's resource must answer as a read of nothing. */
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

/** T024. A list's correct answer to "nothing of yours here" is an empty result —
 * and NOT A PAGE, on this platform, today. `GET /v1/webhooks` takes no `limit` and
 * no `cursor` and returns a bare array, so EIR-API-06's cursor pagination is unmet
 * on the only list route there is. The assertion is emptiness in whatever form the
 * endpoint returns, and the gap is recorded as walked into rather than caused
 * (research R27). */
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
 * Three shapes because the platform has two and a future route may have neither:
 * `GET /v1/webhooks` answers a bare array, a paginated route answers
 * `{ data: [...] }`, and anything else has no rows to count. Exported and pure
 * because only ONE of those arms can execute against the routes that exist today,
 * and a count of zero from an unrecognised shape reads exactly like a count of
 * zero from a correctly-scoped list — which is the one answer this suite must
 * never confuse with success. */
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
  const serialised = JSON.stringify(answer.body ?? "");
  return {
    status: answer.status,
    count: rows.length,
    leaked: foreignIds.filter((id) => serialised.includes(id)),
    body: answer.body,
  };
}

/** T025. A write against another tenant's identifier must change nothing, and the
 * pair must still be indistinguishable.
 *
 * THE STATE READ IS THE POINT. A 404 that completed the write is the case no status
 * code reveals, and it is the one a reader should worry about. `readVictimState` is
 * supplied by the caller and goes through `Repository` methods rather than raw SQL:
 * the restored lint ban (FR-043) forbids the query engine outside
 * `services/api/src/db`, and this suite should not need an exemption. */
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

/** T026. The shape the specification did not anticipate.
 *
 * `POST /auth/dev-token` accepts no tenant-owned identifier, so there is nothing to
 * forge — and it is tenant-scoped all the same, because the key it accepts resolves
 * to exactly one environment. The attack is therefore on the credential: mint a
 * token with environment A's key and present it where only B's users belong. Filing
 * this route as exempt is how a route stops being attacked while looking accounted
 * for (research R4). */
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
    headers: { authorization: `Bearer ${attackerCredential}`, "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });
  if (!mint.ok) return { minted: false, crossStatus: mint.status, crossBody: await mint.json() };
  const { token } = (await mint.json()) as { token: string };
  const answer = await send(baseUrl, token, victimReq);
  return { minted: true, crossStatus: answer.status, crossBody: answer.body };
}
