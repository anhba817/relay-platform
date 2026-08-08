-- Chapter 3.1 — the tenancy hierarchy (FR-TEN-01/02/03/04/07).
--
-- REVIEW DISPOSITION: drizzle-kit generated this file from schema.ts and it
-- was reviewed before being applied (the ADR-16 workflow). One statement was
-- rewritten by hand:
--
--   generated:  ALTER TABLE "applications" ADD COLUMN "organisation_id" uuid NOT NULL;
--
-- That fails on any database that already has application rows — which every
-- reader's does, because chapter 2.1's createEnvironment has been minting them
-- since Part 2. A NOT NULL column cannot appear on a populated table without
-- saying what the existing rows should hold. Replaced by the three-step shape
-- below: add nullable, backfill, then constrain.
--
-- The backfill gives every orphaned application its own organisation and
-- reuses the application's uuid as the organisation's, so the lineage stays
-- readable afterwards: an organisation whose id matches an application is one
-- this migration invented.

CREATE TABLE "humans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "humans_provider_account_unique" UNIQUE("provider","provider_account_id"),
	CONSTRAINT "humans_provider_check" CHECK ("humans"."provider" IN ('github','google'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organisation_id" uuid NOT NULL,
	"human_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organisation_id_human_id_pk" PRIMARY KEY("organisation_id","human_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 1. add it nullable, so the column can exist alongside the rows that predate it
ALTER TABLE "applications" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint
-- 2. backfill: one organisation per orphan, id carried across for traceability
INSERT INTO "organisations" ("id", "name")
SELECT a."id", 'migrated: ' || a."name" FROM "applications" a WHERE a."organisation_id" IS NULL;--> statement-breakpoint
UPDATE "applications" SET "organisation_id" = "id" WHERE "organisation_id" IS NULL;--> statement-breakpoint
-- 3. and only now is the constraint true of every row
ALTER TABLE "applications" ALTER COLUMN "organisation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_application_kind_unique" UNIQUE("application_id","kind");