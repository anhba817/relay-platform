#!/usr/bin/env node
// Apply the analytical schema, and say what it did.
//
// WHY THIS EXISTS AT ALL, GIVEN `CREATE ... IF NOT EXISTS`. That form is idempotent and
// SILENT: it cannot tell you whether it created the table or found it. A second store
// needs the other half -- a run that applies nothing has to PRINT that it applied
// nothing, because a zero that proves the instrument looked is worth more than a zero.
//
// NO CLICKHOUSE CLIENT PACKAGE. Node 22's own `fetch` against the HTTP interface is the
// whole transport, which is what makes `grep -c clickhouse pnpm-lock.yaml` stay at 0 by
// design rather than by luck.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = "relay_analytics";
const PORT = process.env.RELAY_CLICKHOUSE_HTTP_PORT || "8123";
const HOST = process.env.RELAY_CLICKHOUSE_HOST || "localhost";
const USER = process.env.RELAY_CLICKHOUSE_USER || "relay";
const PASS = process.env.RELAY_CLICKHOUSE_PASSWORD || "relay";
const URL = `http://${HOST}:${PORT}/`;

/** One statement, posted. The HTTP interface REFUSES a multi-statement body --
 *  `Code: 62 ... Multi-statements are not allowed` -- which is why `analytics/` is a
 *  directory of statements rather than of files that happen to hold some. */
async function run(sql) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0]);
  return text;
}

/** Strip SQL comments and string literals, so a `;` inside either is not a statement
 *  boundary and the word `relay_analytics` inside a comment does not satisfy T015b. */
function strip(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
    } else if (sql[i] === "'") {
      i++;
      while (i < sql.length && sql[i] !== "'") i += sql[i] === "\\" ? 2 : 1;
    } else {
      out += sql[i];
    }
  }
  return out;
}

/** TWO REFUSALS, BOTH UP FRONT RATHER THAN MID-RUN.
 *
 *  One statement per file, because the interface rejects more than one and because a
 *  ledger keyed on filename only means something if a filename is one change.
 *
 *  And every statement must NAME THE DATABASE. `CLICKHOUSE_DB` creates `relay_analytics`
 *  without making it the session's -- `SELECT currentDatabase()` answers `default` -- so
 *  an unqualified CREATE TABLE succeeds INTO `default`, with no error, and the schema
 *  then exists somewhere nothing else looks. Refusing here makes that impossible rather
 *  than handling it after the fact. */
function check(name, sql) {
  const bare = strip(sql);
  const statements = bare.split(";").filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    throw new Error(
      `${name} holds ${statements.length} statements; the HTTP interface allows one ` +
        `(Code: 62, Multi-statements are not allowed), and the ledger is keyed on filename`,
    );
  }
  if (!bare.includes(`${DB}.`)) {
    throw new Error(
      `${name} does not name the ${DB} database. An unqualified statement applies to ` +
        `\`default\` successfully and silently -- qualify it as ${DB}.<name>`,
    );
  }
}

const sum = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function dropAll() {
  // ONE NAMED DATABASE. Not an unqualified `DROP DATABASE`, and not a table-by-table
  // sweep: dropping the source table under a live materialised view SUCCEEDS with no
  // error and leaves the view answering queries with zeros. It does not re-create --
  // the bootstrap does that on the next run, and `system.tables` reports 0 for a
  // database that does not exist rather than erroring, so the after-check stays honest.
  await run(`DROP DATABASE IF EXISTS ${DB}`);
  console.log(`dropped database ${DB}`);
}

async function main() {
  if (process.argv.includes("--drop-all")) return dropAll();

  const files = readdirSync(HERE).filter((f) => f.endsWith(".sql")).sort();
  const bodies = new Map();
  for (const f of files) {
    const sql = readFileSync(join(HERE, f), "utf8");
    check(f, sql); // refuse the whole directory before applying any of it
    bodies.set(f, sql);
  }

  // THE BOOTSTRAP IS TWO STATEMENTS THE DIRECTORY DOES NOT CONTAIN, and the order is an
  // argument rather than a preference: a ledger cannot record its own creation from a
  // table that does not exist, and it cannot live in a database that does not exist
  // either. `CLICKHOUSE_DB` does not reliably create one -- on a data directory that
  // already holds a database the entrypoint skips initialisation and the variable is
  // read and ignored -- so this line is the only thing that ever creates it.
  await run(`CREATE DATABASE IF NOT EXISTS ${DB}`);
  const ledgerFile = "0002_schema_applied.sql";
  if (!bodies.has(ledgerFile)) throw new Error(`${ledgerFile} is missing; it is the ledger`);
  await run(bodies.get(ledgerFile));

  const rows = await run(
    `SELECT filename, checksum FROM ${DB}.schema_applied ORDER BY filename FORMAT TSV`,
  );
  const seen = new Map(
    rows.trim().split("\n").filter(Boolean).map((l) => l.split("\t")),
  );

  const applied = [];
  const skipped = [];
  for (const f of files) {
    const body = bodies.get(f);
    const cs = sum(body);
    if (seen.has(f)) {
      // A LEDGER THAT CLAIMS A SCHEMA IS APPLIED WHEN IT IS NOT IS WORSE THAN ONE THAT
      // HAS NOT RUN. ClickHouse has no ALTER path for most of what these files do, so an
      // edited file cannot be re-applied and must not be silently skipped either.
      if (seen.get(f) !== cs) {
        throw new Error(
          `${f} changed after it was applied (ledger ${seen.get(f)}, file ${cs}). ` +
            `ClickHouse has no ALTER path for most of this; add a new statement file instead`,
        );
      }
      skipped.push(f);
      continue;
    }
    if (f !== ledgerFile) await run(body);
    await run(`INSERT INTO ${DB}.schema_applied (filename, checksum) VALUES ('${f}', '${cs}')`);
    applied.push(f);
  }

  // A RUN THAT APPLIES NOTHING SAYS SO. This is the line `CREATE ... IF NOT EXISTS`
  // cannot produce, and the reason this script exists beside it.
  console.log(`database ${DB} ready`);
  console.log(
    applied.length ? `applied ${applied.length}: ${applied.join(", ")}` : "applied nothing",
  );
  console.log(
    skipped.length ? `skipped ${skipped.length}: ${skipped.join(", ")}` : "skipped nothing",
  );
}

main().catch((err) => {
  process.stderr.write(`apply failed: ${err.message}\n`);
  process.exit(1);
});
