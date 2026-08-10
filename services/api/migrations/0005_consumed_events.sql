-- Chapter 3.4 — the consumer deduplication ledger (SAD risk R5).
--
-- REVIEW DISPOSITION: drizzle-kit generated this from schema.ts and it was read
-- line by line before being applied (the ADR-16 workflow). Nothing was
-- rewritten. Two things were checked rather than assumed:
--
--   * the PRIMARY KEY is composite, (consumer, event_id) — that constraint IS
--     the deduplication, so a wrong key here would silently turn "handled once"
--     into "handled once per consumer per restart";
--   * there is no foreign key to anything. The ledger records that a consumer
--     handled an event id, and the events themselves live in the broker, not in
--     a table this could reference.
--
-- Deliberately absent: an environment_id (this is platform bookkeeping, like
-- the outbox), an event body (recording that something was handled needs none
-- of a tenant's message text, NFR-SEC-06), and any pruning. Rows stop earning
-- their keep once an event is older than the stream's 7-day retention, because
-- a message that can no longer be redelivered can no longer be a duplicate.

CREATE TABLE "consumed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"handled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
