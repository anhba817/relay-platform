import { connect, type Socket } from "node:net";

// WHAT THE SCAN PROMISES, AND WHAT IT DOES NOT (FR-014).
//
// **A SIGNATURE SCANNER DETECTS KNOWN SIGNATURES.** It does not detect a file crafted
// this morning, it does not detect a payload that is harmless to ClamAV and hostile to
// the browser that renders it, and it does not make an object safe to serve. SAD R9
// names *"scanner misses"* as residual risk, accepted rather than eliminated. A reader
// who finishes this chapter believing *scanned* means *safe* has learned something
// false, and the platform would be the thing that taught them.
//
// AND THE SIGNATURE DATABASE IS A CLOCK. Measured: a freshly started container answers
// `zVERSION` with a thirteen-day-old database for the first ~25 seconds and a current
// one afterwards, because `freshclam` downloads 355,678 signatures on boot. The
// scanner is UP and ANSWERING throughout that window. `compose.yaml`'s health check
// reads the build date for that reason, and EICAR cannot catch it: that signature is in
// `main.cvd` at version 63, unchanged across both, so the test that proves the scanner
// runs is structurally unable to prove it is current.
//
// NO CLIENT LIBRARY. `INSTREAM` is `zINSTREAM\0`, then a four-byte big-endian length
// before each chunk, then a zero length. ADR-30's precedent — twenty-eight lines of
// `node:crypto` rather than two AWS packages — and the same ratio: `clamscan` and
// `clamav.js` wrap a protocol that fits in this file.

/** The answer, as the scanner gives it.
 *
 * THREE OUTCOMES AND NOT TWO. `clean` and `infected` are verdicts; `unavailable` is the
 * absence of one, and the difference is the whole of FR-009. A worker that collapsed
 * them would record "we could not tell" as "nothing found" and let an unscanned object
 * reach `ready`. */
export type ScanResult =
  | { outcome: "clean" }
  | { outcome: "infected"; signature: string }
  | { outcome: "unavailable"; reason: string };

export interface ScannerConfig {
  host: string;
  port: number;
  timeoutMs?: number;
}

export function scannerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ScannerConfig {
  return {
    host: env["RELAY_CLAMAV_HOST"] ?? "localhost",
    port: Number(env["RELAY_CLAMAV_PORT"] ?? 3310),
    // 100 MB THROUGH A SIGNATURE ENGINE IS NOT A FAST OPERATION, and the failure this
    // bounds is a scanner that accepts the connection and never answers — which, with
    // no timeout, holds a sweep open forever and stops every other object behind it.
    ...(env["RELAY_CLAMAV_TIMEOUT_MS"]
      ? { timeoutMs: Number(env["RELAY_CLAMAV_TIMEOUT_MS"]) }
      : {}),
  };
}

const CHUNK = 64 * 1024;

/** Stream bytes through the scanner.
 *
 * CHUNKED, NOT BUFFERED, AND THE FIGURE IS WHY. Measured: `await res.arrayBuffer()` on
 * a 100 MB object costs **142.7 MB of RSS** — 1.4× the object, because the copy and the
 * original are both live. The source here is an async iterable, so the worker holds one
 * 64 KiB chunk at a time whatever the object's size.
 *
 * AND `unavailable` IS RETURNED, NOT THROWN, for a connection this cannot make. The
 * caller's response to "the scanner is down" is to record nothing and sweep again, which
 * is an outcome rather than an error — a thrown exception would be caught two layers up
 * beside a genuine bug and treated the same way. */
export async function scan(
  config: ScannerConfig,
  bytes: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<ScanResult> {
  let socket: Socket;
  try {
    socket = await openSocket(config);
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const reply = await converse(socket, bytes, config.timeoutMs ?? 120_000);
    return interpret(reply);
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    socket.destroy();
  }
}

function openSocket(config: ScannerConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    // A CONNECT DEADLINE OF ITS OWN, shorter than the scan's. A refused connection
    // answers immediately; an address that black-holes does not answer at all, and
    // without this the worker would wait the whole scan budget to learn nothing.
    socket.setTimeout(5_000);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("scanner did not accept a connection"));
    });
    socket.once("error", reject);
  });
}

async function converse(
  socket: Socket,
  bytes: AsyncIterable<Uint8Array> | Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const reply = new Promise<string>((resolve, reject) => {
    let out = "";
    socket.setTimeout(timeoutMs);
    socket.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    socket.once("end", () => resolve(out.replace(/\0/g, "").trim()));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("scanner did not answer"));
    });
    socket.once("error", reject);
  });

  socket.write(Buffer.from("zINSTREAM\0", "ascii"));
  const source =
    bytes instanceof Uint8Array ? [bytes] : (bytes as AsyncIterable<Uint8Array>);
  for await (const part of source) {
    for (let at = 0; at < part.length; at += CHUNK) {
      const slice = part.subarray(at, at + CHUNK);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(slice.length);
      socket.write(length);
      socket.write(slice);
    }
  }
  // A ZERO LENGTH ENDS THE STREAM. Without it the scanner waits for more bytes and the
  // read above times out — which reads as "the scanner is down" for a scanner that is
  // working perfectly.
  socket.write(Buffer.alloc(4));
  return reply;
}

/** `stream: OK`, `stream: <Signature> FOUND`, or an error line.
 *
 * ANYTHING UNRECOGNISED IS `unavailable`, NOT `clean`. A protocol answer this does not
 * understand is a reason to try again, and reading it as "nothing found" is the one
 * mistake in this file that would let an infected object reach `ready`. */
export function interpret(reply: string): ScanResult {
  if (/\bOK$/.test(reply)) return { outcome: "clean" };
  const found = /:\s*(.+?)\s+FOUND$/.exec(reply);
  if (found) return { outcome: "infected", signature: found[1]! };
  return { outcome: "unavailable", reason: reply || "empty reply" };
}

/** The scanner's own version line, for the staleness check and for a chapter figure.
 *
 * `ClamAV 1.5.4/28135/Sat Sep 26 06:24:13 2026` — engine, signature database version,
 * build date. **The third field is the only one that carries the fact**, and a liveness
 * probe (`zPING` → `PONG`) passes without any of them. */
export async function version(config: ScannerConfig): Promise<string | null> {
  let socket: Socket;
  try {
    socket = await openSocket(config);
  } catch {
    return null;
  }
  try {
    const reply = new Promise<string>((resolve, reject) => {
      let out = "";
      socket.setTimeout(5_000);
      socket.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      socket.once("end", () => resolve(out.replace(/\0/g, "").trim()));
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("no answer"));
      });
      socket.once("error", reject);
    });
    socket.write(Buffer.from("zVERSION\0", "ascii"));
    return await reply;
  } catch {
    return null;
  } finally {
    socket.destroy();
  }
}
