// Opaque history cursors (chapter 2.4). The token encodes a sequence
// position; clients treat it as a black box (constitution V: "List
// endpoints use opaque cursor pagination; offset pagination is not
// offered"). The structure inside may change at any time — a timestamp
// for retention-aware reads, a shard hint at 10x scale — and no client
// breaks, because no client ever saw inside.

const PREFIX = "s:";

export function encodeCursor(seq: number): string {
  return Buffer.from(`${PREFIX}${seq}`, "utf8").toString("base64url");
}

/** Decode a cursor, or null if the token is not one of ours. Callers turn
 * null into a 400 through the usual envelope — never a 500, and never a
 * silent fallback to "start from the top", which would quietly serve the
 * wrong page. */
export function decodeCursor(token: string): number | null {
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^s:(\d+)$/.exec(raw);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}
