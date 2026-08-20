// The local infrastructure, named. The compose file at the repository root
// (compose.yaml) is the source of truth; these constants let the rest of the
// workspace — and the smoke test beside this file — refer to it without
// parsing YAML. This is a new file on purpose: files fenced by earlier
// chapters are read-only from then on (chapter 1.2's additive-only rule).

export const COMPOSE_FILE = "compose.yaml";

export const INFRA_SERVICES = [
  "postgres",
  "redis",
  "nats",
  "clickhouse",
  // Chapter 3.8. The fifth, and the only one that is not a store: Mailpit
  // catches the SMTP the notification relay sends so a test can read what was
  // RECEIVED rather than what was passed (FR-021).
  "mailpit",
] as const;

export const DURABLE_VOLUMES = [
  "postgres-data",
  "nats-data",
  "clickhouse-data",
] as const;
