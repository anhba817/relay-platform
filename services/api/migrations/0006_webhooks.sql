-- Chapter 3.5 — webhook endpoints, the delivery schedule, and dead letters.
--
-- REVIEW DISPOSITION: drizzle-kit generated this from schema.ts and it was read
-- line by line before being applied (the ADR-16 workflow). Nothing was
-- rewritten. Five things were checked rather than assumed:
--
--   * all three tables carry environment_id NOT NULL with a foreign key to
--     environments. Unlike 3.3's outbox and 3.4's consumed_events, these are
--     tenant data, and the rule distinguishing the two cases is stated in
--     schema.ts rather than left for the next chapter to infer;
--   * webhook_deliveries has UNIQUE (event_id, endpoint_id). That constraint IS
--     the idempotence of expansion — one event produces at most one delivery per
--     endpoint however many times the event is redelivered, enforced by the
--     database rather than by care;
--   * webhook_deliveries_due_idx is PARTIAL, on next_attempt_at WHERE state =
--     'pending'. It covers the relay's only query and nothing else, so delivered
--     rows cost nothing to keep — the same shape as 3.3's outbox index;
--   * the state CHECK admits exactly pending / delivered / dead. There is no
--     fourth state to get stuck in;
--   * webhook_endpoints.deleted_at exists because DELETION IS SOFT. The foreign
--     keys from deliveries and dead letters are ON DELETE NO ACTION on purpose:
--     a hard delete would have to cascade, and cascading would erase a
--     customer's dead letters, which FR-WHK-04 says to retain for seven days.
--     Chapter 3.2 reached the same conclusion for api_keys.revoked_at.

CREATE TABLE "webhook_dead_letters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"last_status" integer,
	"last_error" text,
	"attempts" integer NOT NULL,
	"dead_lettered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event_endpoint_unique" UNIQUE("event_id","endpoint_id"),
	CONSTRAINT "webhook_deliveries_state_check" CHECK ("webhook_deliveries"."state" IN ('pending','delivered','dead'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"url" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_previous_ciphertext" text,
	"secret_rotated_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "webhook_dead_letters_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "webhook_dead_letters_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_dead_letters_environment_idx" ON "webhook_dead_letters" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_endpoints_environment_idx" ON "webhook_endpoints" USING btree ("environment_id");