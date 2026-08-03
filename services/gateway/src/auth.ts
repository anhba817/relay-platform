import { jwtVerify } from "jose";

// The door (chapter 2.5). Tokens are verified BEFORE the upgrade
// completes — an unauthenticated socket never reaches session code.
//
// DECISION (chapter 2.5): real tokens are minted by Part 3 (the dev-token
// endpoint is FR-AUT-09; per-environment signing secrets live in the
// environments table). Until then, dev tokens are HS256 over
// RELAY_DEV_JWT_SECRET with claims { sub: user external_id,
// env: environment_id } — a seam Part 3 replaces without touching the
// session code behind it.

export const DEV_JWT_SECRET = process.env.RELAY_DEV_JWT_SECRET ?? "dev-secret";

export interface Identity {
  userExternalId: string;
  environmentId: string;
}

export async function verifyToken(token: string): Promise<Identity | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(DEV_JWT_SECRET),
    );
    // Non-EMPTY strings: `typeof x === "string"` happily accepts "", and an
    // empty environment claim would open a session scoped to no tenant —
    // which constitution I says must be unrepresentable, not merely
    // unlikely. Found by the test below, not by reading the code.
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.env !== "string" ||
      payload.env.length === 0
    ) {
      return null;
    }
    return { userExternalId: payload.sub, environmentId: payload.env };
  } catch {
    return null;
  }
}
