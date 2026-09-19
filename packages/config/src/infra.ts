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
  // The fifth, and the only one that is not a store: Mailpit
  // catches the SMTP the notification relay sends so a test can read what was
  // RECEIVED rather than what was passed (FR-021).
  "mailpit",
  // The sixth, and hosted media's (ADR-13, chapter 4.10). The api signs a URL and
  // the CLIENT uploads to it, so this container is reachable from outside the
  // network in a way the stores are not — and its host port is 9100, not MinIO's
  // conventional 9000, because ClickHouse's native port has published 9000 since
  // this file was written.
  "minio",
] as const;

export const DURABLE_VOLUMES = [
  "postgres-data",
  "nats-data",
  "clickhouse-data",
  // Objects outlive the process that wrote them by definition; a media store that
  // forgot its bucket on `compose down` would make every `media_id` in Postgres
  // point at nothing.
  "minio-data",
] as const;
