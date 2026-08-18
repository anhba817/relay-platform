-- Chapter 3.6 — the failure run, automatic disablement, and its notification.
--
-- REVIEW DISPOSITION: drizzle-kit generated this from schema.ts and it was read
-- line by line before being applied (the ADR-16 workflow, and chapter 2.1's rule
-- after a generated migration was once applied unread). Nothing was rewritten;
-- two CHECK constraints were added to schema.ts and the file regenerated. Six
-- things were checked rather than assumed:
--
--   * EVERY NEW COLUMN ON webhook_endpoints IS NULLABLE WITH NO DEFAULT, and that
--     is the single most important line in this file. A default of `now()` on
--     failure_run_started_at would have opened a failure run for every endpoint
--     in the platform at deploy time, and an hour later the sweep would have
--     disabled all of them. Nullable-and-null means every existing endpoint is
--     healthy the moment this applies, which is true;
--   * `synthetic boolean DEFAULT false NOT NULL` is the one non-null addition,
--     and the backfill it implies is correct: every delivery that already exists
--     was a real event, not a test;
--   * webhook_disable_notifications carries environment_id NOT NULL with a
--     foreign key (constitution I). organisation_id is NOT NULL too and is
--     denormalised on purpose — the row records an obligation as it stood, and an
--     application moving between organisations must not retarget a notification
--     already owed to somebody else;
--   * all three foreign keys are ON DELETE NO ACTION, the choice 3.5 made and
--     for its reason: deletion is soft, and a cascade would erase records the
--     platform is required to keep;
--   * webhook_endpoints_failure_run_idx is PARTIAL, on failure_run_started_at
--     WHERE enabled AND the run is open. It covers the sweep's only query and
--     nothing else, so a healthy endpoint costs nothing to keep out of it — the
--     same shape as 3.3's outbox index and 3.5's delivery index;
--   * the two CHECK constraints make the run's halves and the disable stamp's
--     halves travel together. Neither was in the generated output, and neither is
--     decoration: `shouldDisable` reads a missing attempt count as zero, which
--     would disable nothing and look like a policy decision rather than a bug.
--
-- No statement here is destructive, and there is no down path (forward-only).

CREATE TABLE "webhook_disable_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"run_attempts" integer NOT NULL,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_status" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "failure_run_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "failure_run_attempts" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "webhook_disable_notifications" ADD CONSTRAINT "webhook_disable_notifications_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_disable_notifications" ADD CONSTRAINT "webhook_disable_notifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_disable_notifications" ADD CONSTRAINT "webhook_disable_notifications_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_disable_notifications_environment_idx" ON "webhook_disable_notifications" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_failure_run_idx" ON "webhook_endpoints" USING btree ("failure_run_started_at") WHERE "webhook_endpoints"."enabled" AND "webhook_endpoints"."failure_run_started_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_failure_run_check" CHECK (("webhook_endpoints"."failure_run_started_at" IS NULL) = ("webhook_endpoints"."failure_run_attempts" IS NULL));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_disabled_check" CHECK (("webhook_endpoints"."disabled_at" IS NULL) = ("webhook_endpoints"."disabled_reason" IS NULL));