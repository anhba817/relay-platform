// One batch, fetched and written. The ingester's actual work.
//
// THIS IS NOT IN `main.ts`, AND THAT IS THE ARGUMENT RATHER THAN A FILE LAYOUT PREFERENCE.
// `vitest.coverage.config.mts` excludes `**/main.ts` from collection, because entry points are
// "reached by running the service, not by asserting on it". Sound about a `bootstrap` that
// wires a process together. Not sound about this function: it is exported, it is called
// directly by `ingest.itest.ts`, and it holds the batch bounds, the acknowledgement ordering,
// the poison rule and the routing. It is the one thing in this service worth measuring.
//
// While it lived in `main.ts` the config ALSO pinned `services/ingester/src/main.ts` at
// branches 33 — a per-file threshold whose key matched no collected file, so it could not
// fail. Measured: 45 per-file pins in that config, exactly 1 unbindable, and it was this one.
import type { NatsConnection } from "nats";

import { ANALYTICS_STREAM } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { ClickHouse } from "./clickhouse.js";
import { route, type AttemptRow, type ConnectionRow, type RequestRow } from "./shape.js";

// TWO BOUNDS, AND THEY ARE THE SAD's RATHER THAN DR-11's. `docs/05-sad.md` §4 describes this
// service as batch-inserting "every 2 s or 10k rows (DR-11)" and chose those numbers; DR-11
// itself reads, in full, "Inserts shall be batched or use asynchronous insert mode; single-row
// synchronous inserts are prohibited" -- no interval and no row count. This comment credited
// the clause with both until analysis pass 11 opened it.
//
// It takes BOTH because each fails alone: a row count never flushes for a quiet tenant, and an
// interval has no ceiling under load. 049 measured where they cross, at 5,000 records/second.
export const BATCH_ROWS = 10_000;
export const BATCH_MS = 2_000;

export const DURABLE = "analytics-ingester";

export interface IngestResult {
  written: number;
  /** Split by table, because one number cannot say which one moved. */
  writtenAttempts: number;
  writtenRequests: number;
  writtenConnections: number;
  malformed: number;
  /** Records this consumer recognised as somebody else's and left on the stream. A record
   *  nobody claims has to be visible as a number, or the difference between "nothing arrived"
   *  and "everything arrived and none of it was mine" is invisible. */
  unclaimed: number;
}

export async function ingestOnce({
  nc,
  store,
  logger,
  batchRows = BATCH_ROWS,
  batchMs = BATCH_MS,
  stream = ANALYTICS_STREAM,
  durable = DURABLE,
}: {
  nc: NatsConnection;
  store: ClickHouse;
  logger: Logger;
  batchRows?: number;
  batchMs?: number;
  /** The stream and durable are parameters so a test can use its own rather than
   *  publishing probe records into the platform's. The defaults are the real ones. */
  stream?: string;
  durable?: string;
}): Promise<IngestResult> {
  const js = nc.jetstream();
  const consumer = await js.consumers.get(stream, durable);

  const attempts: AttemptRow[] = [];
  const requests: RequestRow[] = [];
  const connections: ConnectionRow[] = [];
  const pending: Array<{ ack: () => void }> = [];
  let malformed = 0;
  let unclaimed = 0;

  const messages = await consumer.fetch({ max_messages: batchRows, expires: batchMs });
  for await (const m of messages) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(m.data));
    } catch {
      parsed = null;
    }

    const routed = route(parsed);

    if (routed.kind === "malformed") {
      // NAMED BY ITS SEQUENCE, NEVER BY ITS CONTENTS. The record carries `error` -- up to
      // 2000 characters of a third-party endpoint's response, capable of echoing back
      // anything -- and constitution VI keeps secrets, tokens and message content out of
      // logs. The record survives in the stream for the retention window, so the sequence
      // is enough to go and fetch it deliberately, which is the difference between an
      // investigation and a leak.
      malformed += 1;
      logger.log("error", "ingester.malformed_record", { stream_sequence: m.seq });
      m.term();
      continue;
    }

    if (routed.kind === "unclaimed") {
      // NEITHER ACKED NOR TERMINATED. Acking would consume a record this consumer did not
      // write; terminating would destroy it. Left alone it is redelivered until something
      // claims it or the stream's seven days expire -- and the count below is the only way
      // anyone finds out that is happening.
      unclaimed += 1;
      continue;
    }

    if (routed.kind === "attempt") attempts.push(routed.row);
    else if (routed.kind === "request") requests.push(routed.row);
    else connections.push(routed.row);
    pending.push({ ack: () => m.ack() });
  }

  // ACKNOWLEDGE ONLY AFTER THE INSERT RETURNS. A record that was not written is not
  // acknowledged, which is what makes the store being unreachable a delay rather than a loss.
  // BOTH INSERTS BEFORE ANY ACK. If the second throws, nothing in this batch is
  // acknowledged and the whole batch is redelivered -- which re-inserts the rows the first
  // call already wrote. That is safe because both tables are ReplacingMergeTree keyed on the
  // record's own key, and it is the reason that choice is not merely about redelivery.
  await store.insert(attempts);
  await store.insertRequests(requests);
  await store.insertConnections(connections);
  for (const p of pending) p.ack();

  return {
    written: attempts.length + requests.length + connections.length,
    writtenAttempts: attempts.length,
    writtenRequests: requests.length,
    writtenConnections: connections.length,
    malformed,
    unclaimed,
  };
}
