// A customer's webhook endpoint, behaving badly on purpose (chapter 3.5).
//
//   node scripts/hostile-endpoint.mjs --mode=ok      # 200, and prints what arrived
//   node scripts/hostile-endpoint.mjs --mode=fail    # always 500
//   node scripts/hostile-endpoint.mjs --mode=hang    # accepts, never responds
//   node scripts/hostile-endpoint.mjs --mode=flaky   # fails twice, then succeeds
//
//   --port=4555      fixed port (default). --port=0 asks the OS for a free one.
//   --quiet          one line per request instead of the full envelope
//   --host=0.0.0.0   bind beyond loopback, so a container can reach it
//   --secret=SECRET  verify every signature, the way a customer would
//   --reserialize    verify against a RE-SERIALISED body, and watch it fail
//
// THREE MODES, because a retry system has three interesting inputs and only one
// of them is "the customer is down". A 500 is a server that answered; a hang is
// a server that took the request and said nothing, which is the one that costs
// the platform a worker rather than a round trip; and `flaky` is the ordinary
// case the schedule exists for — a customer who was briefly unwell and recovers,
// where the whole point is that nobody had to intervene.
//
// This is the same artifact the integration suite drives. One endpoint, run by a
// reader by hand and by the tests in CI, so neither can rot without the other
// noticing — 3.3's dual-write walk and 3.4's consumer walk made the same
// argument, and this script prints the same MARKER lines a parent process can
// watch for.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const MODE = arg("mode", "ok");
const SECRET = arg("secret", "");
const RESERIALIZE = flag("reserialize");
const PORT = Number(arg("port", "4555"));
const QUIET = flag("quiet");
/** Loopback by default — this is a toy server that prints request bodies, and it
 * should not be on the network unless somebody asks. `--host=0.0.0.0` is what the
 * quickstart's V6 needs, where the dispatcher is in a container. */
const HOST = arg("host", "127.0.0.1");

if (!["ok", "fail", "hang", "flaky"].includes(MODE)) {
  console.error(`unknown --mode=${MODE} (expected ok, fail, hang or flaky)`);
  process.exit(2);
}

/** Held open deliberately. A hanging endpoint that closed its sockets would be a
 * refused connection — a different failure, and a much cheaper one. */
const held = new Set();
let count = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += String(chunk)));
  req.on("end", () => {
    count += 1;
    const n = count;

    // The headers are the interesting part, so they are printed by default. A
    // reader comparing two attempts sees the SAME signature and the same
    // timestamp only if the platform re-sent an identical request; the retry
    // schedule re-signs, so they differ, and that is worth seeing.
    if (QUIET) {
      console.log(
        `#${n} ${req.method} ${req.url} event=${req.headers["relay-event-id"] ?? "?"}`,
      );
    } else {
      console.log(`\n--- request #${n} -------------------------------------`);
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.startsWith("relay-") || key === "content-type") {
          console.log(`  ${key}: ${value}`);
        }
      }
      console.log(`  body: ${body}`);
    }
    // The line a parent process watches for. Chapter 3.4's walk established the
    // convention; keeping it means a test can count arrivals without parsing
    // whatever the pretty output happens to look like this year.
    console.log(`MARKER received n=${n} mode=${MODE}`);

    // VERIFICATION, done here on purpose. This script imports nothing from the
    // platform — `node:crypto` and the documented recipe are the whole
    // dependency list. If a signature can only be checked with our own code then
    // what we published is not a contract, and the way to find that out is to
    // write the customer's side without looking at ours.
    if (SECRET) {
      const timestamp = req.headers["relay-webhook-timestamp"];
      const header = String(req.headers["relay-webhook-signature"] ?? "");
      // One header can carry SEVERAL signatures during a rotation — the customer
      // accepts the request if any of them matches, which is what lets a secret
      // be replaced without a synchronised deployment.
      const offered = header.split(",").map((p) => p.trim().replace(/^v1=/, ""));

      // --reserialize parses and re-stringifies with the top-level keys SORTED:
      // the same DATA, a different rendering.
      //
      // The sort is not gratuitous. A plain `JSON.stringify(JSON.parse(body))`
      // in this runtime gives back the bytes it was handed — which is precisely
      // why this bug survives every test written in the same language as the
      // service, and then appears the day a customer verifies in Go, or a proxy
      // normalises the JSON, or somebody spreads the object into a new one to
      // add a field. The sort makes that day happen now.
      const parsed = RESERIALIZE ? JSON.parse(body) : null;
      const body_ = RESERIALIZE
        ? JSON.stringify(
            Object.fromEntries(Object.keys(parsed).sort().map((k) => [k, parsed[k]])),
          )
        : body;
      const expected = createHmac("sha256", SECRET)
        .update(`v1:${timestamp}:${body_}`)
        .digest("hex");

      const ok = offered.some((candidate) => {
        const a = Buffer.from(candidate, "hex");
        const b = Buffer.from(expected, "hex");
        return a.length === b.length && timingSafeEqual(a, b);
      });
      console.log(
        `MARKER signature n=${n} ${ok ? "VERIFIED" : "FAILED"}` +
          (RESERIALIZE ? " (body re-serialised)" : ""),
      );
      if (!ok && RESERIALIZE) {
        console.log(
          "  ^ the data is identical and the signature does not match. Sign and\n" +
            "    verify the BYTES that were transmitted, never the object.",
        );
      }
    }

    if (MODE === "hang") {
      // Accepted and abandoned. No response, no close — the dispatcher's attempt
      // timeout is the only thing that ends this, which is exactly the property
      // FR-WHK-05 is about.
      held.add(res);
      console.log(`MARKER hanging n=${n}`);
      return;
    }

    // `flaky` recovers on the third attempt: far enough in that the reader has
    // watched the schedule widen, well short of the seventh where it would
    // dead-letter instead.
    const status = MODE === "fail" ? 500 : MODE === "flaky" && n < 3 ? 503 : 200;
    console.log(`MARKER answered n=${n} status=${status}`);
    res.writeHead(status, { "content-type": "text/plain" }).end(String(status));
  });
});

// A port already held is the likeliest way this script fails, and the default
// unhandled-error dump buries that under a stack trace. It usually means a
// hostile endpoint from an earlier run is still up — which will happily receive
// the walk's webhooks and log them somewhere the reader is not looking.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `port ${PORT} is already in use — another hostile endpoint is probably still running.\n` +
        "stop it, or pass --port=0 to take whatever the OS offers.",
    );
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  // Printed in a fixed shape so a parent can read the port back when --port=0
  // handed the choice to the OS.
  console.log(`MARKER listening url=http://${HOST}:${port}/hook mode=${MODE}`);
  console.log(`hostile endpoint on http://${HOST}:${port}/hook  (mode: ${MODE})`);
  console.log("ctrl-c to stop\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const res of held) res.destroy();
    server.close(() => process.exit(0));
  });
}
