-- Chapter 3.3 — the transactional outbox (ADR-06).
--
-- REVIEW DISPOSITION: drizzle-kit generated this file from schema.ts and it was
-- read line by line before being applied (the ADR-16 workflow). Nothing was
-- rewritten, and this time there is a stronger reason than "no existing rows":
-- SAD §6.1 DEFINES this table, so the generated SQL was compared against the
-- document rather than only against the TypeScript. It matches column for
-- column — id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL, payload JSONB NOT
-- NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ.
--
-- The INDEX is the one thing §6.1 does not define, and it is a chapter
-- derivation (see the DECISION in schema.ts). It is PARTIAL: it covers only
-- rows the relay actually reads — `published_at IS NULL` — so a table that is
-- almost entirely published rows costs almost nothing to index, and pruning
-- stays an option rather than an obligation.
--
-- Deliberately absent: any status enum, attempts counter or last_error column.
-- `published_at IS NULL` is the whole queue, and retry accounting belongs to
-- webhook delivery in chapter 3.5.

CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" IS NULL;
