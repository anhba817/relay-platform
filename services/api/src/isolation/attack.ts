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
 * So status and whole body are compared. There is nothing to exclude from the
 * comparison yet: the error envelope is `code`, `message` and `docs_url`, all three of
 * which must match. When a per-request field joins it, the chapter that adds it owns
 * the decision to drop it here — and it will have to argue that the field reveals
 * nothing about the resource. */

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

async function send(
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
  const f = JSON.stringify(foreign.body);
  const a = JSON.stringify(absent.body);
  if (f !== a) differences.push(`body ${f} (foreign) vs ${a} (absent)`);
  return differences;
}

/** A read of another tenant's resource must answer as a read of nothing. */
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
