#!/usr/bin/env node
// The integration gate, and what it reports about itself (chapter 4.9, FR-001, SC-002).
//
// `turbo run test:integration --concurrency=1` printed one line about a run of eighteen
// tasks — `Tasks: 8 successful, 10 total` — and four chapters read it as a count of test
// lanes. It is none of those things:
//
//   * eighteen planned is NINE BUILDS and nine test tasks;
//   * three of the nine test tasks are packages with no `test:integration` script at all
//     (`@relay/config`, `@relay/protocol`, `@relay/service-kit`), which complete as
//     successful no-ops;
//   * `--concurrency=1` stops SCHEDULING at the first failure, so the total depends on what
//     was already in flight when the failure arrived. Measured on three chapters' close-out
//     runs against the same tree: `7 of 9`, `8 of 10`, `7 of 11`. **The number does not
//     reproduce**, which is a poor foundation for a requirement.
//
// So this prints the number a reader thought they were getting: how many integration SUITES
// ran, against how many exist. A green tick and a run that stopped after one lane are the
// same exit code without it.
//
// IT REFUSES RATHER THAN GUESSING. A lane that produced no summary line is an error naming
// the lane, not a lane quietly counted as zero — feature 045 spent a feature on a checker
// that compared nothing and exited 0 twenty-six times.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every package that declares a `test:integration` script, with the suites it holds.
 *
 * DERIVED, NOT LISTED. Three drafts of this feature's own task list said "the five
 * integration lanes", "the four lanes" and "six inside the gate", and only the last was
 * right. A list in a comment goes stale the first time somebody adds a package; a walk of
 * the tree cannot. */
function lanes() {
  const found = [];
  for (const group of ["packages", "services"]) {
    const base = join(REPO, group);
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        continue; // not a package
      }
      if (manifest.scripts?.["test:integration"] === undefined) continue;
      found.push({ name: manifest.name, dir, suites: suitesUnder(join(dir, "src")) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function suitesUnder(dir) {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) n += suitesUnder(join(dir, entry.name));
    else if (entry.name.endsWith(".itest.ts")) n += 1;
  }
  return n;
}

// A literal escape character in a source file is a thing a fence and a diff both mangle, so it
// is written as an escape — and `no-control-regex` then objects, correctly for every case but
// this one. Turbo colourises its own prefixes, and a summary line is only parseable with them
// removed.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `Test Files  2 failed | 31 passed (33)`, or `Test Files  12 passed (12)`.
 *
 * The count in parentheses is what vitest COLLECTED, and the two numbers before it are what
 * it finished. A file that fails to import counts in neither, which is why both are read. */
function summaryOf(line) {
  const match = /Test Files\s+(.*)$/.exec(line);
  if (match === null) return null;
  const tail = match[1] ?? "";
  const collected = /\((\d+)\)/.exec(tail);
  if (collected === null) return null;
  const failed = /(\d+) failed/.exec(tail);
  const passed = /(\d+) passed/.exec(tail);
  return {
    collected: Number(collected[1]),
    failed: Number(failed?.[1] ?? 0),
    passed: Number(passed?.[1] ?? 0),
  };
}

const planned = lanes();
// `--filter=!@relay/outsider` excludes the sealed suite BY NAME. It integrates against a
// platform it does not start and runs under `pnpm test:outsider`; it is not an early stop.
const EXCLUDED = ["@relay/outsider"];
const inside = planned.filter((l) => !EXCLUDED.includes(l.name));
const expected = inside.reduce((n, l) => n + l.suites, 0);

const args = [
  "run",
  "test:integration",
  "--concurrency=1",
  // EVERY LANE RUNS, WHICH IS THE CHANGE. Without it a failure in the api lane means the
  // gateway's 12 suites, the e2e journey, the ingester, the dispatcher and the harness are
  // never executed — and the gate reports one failure where six lanes are unknown.
  "--continue",
  ...EXCLUDED.map((name) => `--filter=!${name}`),
  ...process.argv.slice(2),
];

const child = spawn("turbo", args, { cwd: REPO, stdio: ["inherit", "pipe", "inherit"] });
// `turbo` comes from `node_modules/.bin`, which is on PATH inside a pnpm script and is not
// outside one. Saying so beats an unhandled ENOENT with no sentence attached.
child.on("error", (error) => {
  process.stderr.write(
    `integration gate: could not start turbo (${error.message}). ` +
      `Run this through \`pnpm test:integration\`.\n`,
  );
  process.exit(1);
});
const seen = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.replace(ANSI, "");
    const lane = /^(\S+):test:integration:/.exec(line);
    if (lane === null) continue;
    const summary = summaryOf(line);
    if (summary !== null) seen.set(lane[1], summary);
  }
});

child.on("exit", (code) => {
  const rows = inside.map((lane) => ({ ...lane, summary: seen.get(lane.name) }));
  const executed = rows.reduce((n, r) => n + (r.summary?.collected ?? 0), 0);
  const silent = rows.filter((r) => r.summary === undefined && r.suites > 0);

  process.stdout.write("\nintegration gate\n");
  for (const r of rows) {
    const s = r.summary;
    const ran = s === undefined ? "did not run" : `${s.collected} ran, ${s.failed} failed`;
    process.stdout.write(`  ${r.name.padEnd(22)} ${String(r.suites).padStart(3)} suites · ${ran}\n`);
  }
  process.stdout.write(`  ${"".padEnd(22)} ${String(expected).padStart(3)} suites · ${executed} ran\n`);
  for (const name of EXCLUDED) {
    const lane = planned.find((l) => l.name === name);
    if (lane !== undefined) {
      process.stdout.write(
        `  excluded by name: ${name} (${lane.suites} suite(s)) — \`pnpm test:outsider\`\n`,
      );
    }
  }

  // THREE WAYS TO BE RED, AND THE SECOND AND THIRD ARE THE NEW ONES. A lane that failed is
  // the ordinary case; a lane that never reported is a run nobody can read; and fewer suites
  // executed than the tree holds means the gate covered less than it claims to.
  if (silent.length > 0) {
    process.stderr.write(
      `integration gate: no summary from ${silent.map((s) => s.name).join(", ")}\n`,
    );
    process.exit(1);
  }
  if (executed < expected) {
    process.stderr.write(
      `integration gate: ${executed} suites ran of ${expected} in the tree\n`,
    );
    process.exit(1);
  }
  process.exit(code ?? 1);
});
