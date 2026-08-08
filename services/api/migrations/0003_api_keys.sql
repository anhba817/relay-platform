-- Chapter 3.2 — API keys (FR-AUT-01…05, NFR-SEC-02).
--
-- REVIEW DISPOSITION: drizzle-kit generated this file from schema.ts and it was
-- read line by line before being applied (the ADR-16 workflow). Nothing was
-- rewritten this time, and the reason is worth stating: 0002 needed a hand
-- rewrite because it added a NOT NULL column to a populated table. This
-- migration only CREATEs — there are no existing rows to say anything about, so
-- the generated shape is already correct. Reviewing it was still the point; the
-- workflow is "read the SQL", not "read the SQL when you expect a problem".
--
-- Two constraints carry requirements rather than convention:
--   api_keys_public_id_unique  — the lookup runs before any tenant is known, so
--                                the handle must resolve to at most one row
--                                globally (research R2).
--   api_keys_prefix_check      — FR-AUT-03's two prefixes, and nothing else.
--
-- Deliberately absent: any constraint on how many active keys an environment
-- may have. Several at once is the feature, not an oversight (FR-AUT-04) —
-- rotation with no downtime needs the old key to keep working while the new one
-- is deployed.

CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"public_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"salt" text NOT NULL,
	"prefix" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "api_keys_prefix_check" CHECK ("api_keys"."prefix" IN ('rk_dev_','rk_live_'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;