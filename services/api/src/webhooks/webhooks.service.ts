import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import type { Db } from "../db/client";
import {
  createTestDelivery,
  Repository,
  testDeliveryResult,
  type WebhookEndpointRow,
} from "../db/repository";
import { encryptSecret, mintSigningSecret } from "./secret";

// The management surface's rules (chapter 3.5). Two of them are worth stating
// here rather than leaving to the controller, because both are the kind of thing
// that looks like validation and is actually a security boundary.

/** FR-WHK-01, and the error must say the number. Chapter 3.2's lesson about
 * error messages that name the mistake applies to a limit as much as to a
 * credential: "too many endpoints" leaves the reader counting. */
export const MAX_ENDPOINTS_PER_ENVIRONMENT = 5;

/** DECISION (chapter 3.5, research R9): no requirement mandates this check, and
 * without it the dispatcher is a request-forgery primitive pointed at whatever
 * it can reach — a tenant supplies the URL, and the platform fetches it.
 *
 * Deliberately NOT built: DNS re-resolution at delivery time to defeat
 * rebinding, an egress proxy, an allowlist. Each is a real hardening step and
 * each needs infrastructure this platform does not have. Naming them is more
 * honest than implying the simple check is complete; NFR-SEC-07's OWASP scan is
 * where this comes back. */
const BLOCKED_HOSTS = /^(localhost|0\.0\.0\.0|\[?::1\]?)$/i;
const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, and the cloud metadata endpoint lives here
  /^fc00:/i,
  /^fe80:/i,
];

export interface CreateEndpointInput {
  url: string;
  event_types: string[];
}

/** What a customer receives once and never again. */
export interface EndpointWithSecret extends WebhookEndpointRow {
  secret: string;
}

/** How long a caller waits for a test event to come back.
 *
 * The attempt happens in the dispatcher's process, so this route can only watch
 * the row. Ten seconds is above the dispatcher's own attempt timeout, so a
 * customer whose server hangs gets the honest answer — "no response" — rather than
 * this bound firing first and reporting an inconclusive result for a conclusive
 * failure. */
const TEST_EVENT_TIMEOUT_MS = 10_000;
const TEST_EVENT_POLL_MS = 100;

/** What a test event answered, or why there is no answer yet. */
export interface TestEventResult {
  delivered: boolean;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
  event_id: string;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly repo: Repository,
    @Inject("DB") private readonly db: Db,
  ) {}

  async create(input: CreateEndpointInput): Promise<EndpointWithSecret> {
    this.assertDeliverableUrl(input.url);
    this.assertEventTypes(input.event_types);

    const existing = await this.repo.countEndpoints();
    if (existing >= MAX_ENDPOINTS_PER_ENVIRONMENT) {
      throw new UnprocessableEntityException(
        `an environment may have at most ${MAX_ENDPOINTS_PER_ENVIRONMENT} webhook endpoints; this one already has ${existing}`,
      );
    }

    // Minted here, encrypted here, returned here — and never readable again.
    // The plaintext exists in this method's scope and nowhere else.
    const secret = mintSigningSecret();
    const row = await this.repo.createEndpoint({
      url: input.url,
      eventTypes: input.event_types,
      secretCiphertext: encryptSecret(secret),
    });
    return { ...row, secret };
  }

  list(): Promise<WebhookEndpointRow[]> {
    return this.repo.listEndpoints();
  }

  async get(id: string): Promise<WebhookEndpointRow> {
    const row = await this.repo.getEndpoint(id);
    // 404 rather than 403, for an endpoint that exists in another environment as
    // much as for one that never existed: existence itself must not leak
    // (FR-TEN-05).
    if (!row) throw new NotFoundException("no such webhook endpoint");
    return row;
  }

  async rotateSecret(id: string): Promise<EndpointWithSecret> {
    const secret = mintSigningSecret();
    const row = await this.repo.rotateEndpointSecret(id, encryptSecret(secret));
    if (!row) throw new NotFoundException("no such webhook endpoint");
    return { ...row, secret };
  }

  async setEnabled(id: string, enabled: boolean): Promise<WebhookEndpointRow> {
    const row = await this.repo.setEndpointEnabled(id, enabled);
    if (!row) throw new NotFoundException("no such webhook endpoint");
    return row;
  }

  /** Send one synthetic event to one endpoint and report what it answered
   * (chapter 3.6, FR-013…FR-016, research R8).
   *
   * The delivery is REAL: a row on the ordinary schedule, published by the
   * ordinary relay, posted and signed by the ordinary dispatcher, its outcome
   * recorded by the ordinary seam. This method creates it and then WATCHES,
   * because the attempt happens in another process and constitution IV does not
   * let that process write its own answer anywhere else.
   *
   * That is why FR-014 is met rather than approximated. A route that posted the
   * request itself would need a second copy of the signing code, and a test signed
   * by a second copy proves nothing about real deliveries — which is the one thing
   * a test event exists to prove. */
  async sendTestEvent(endpointId: string): Promise<TestEventResult> {
    const created = await createTestDelivery(this.db, {
      endpointId,
      environmentId: this.repo.environment,
    });
    // The same 404 a missing endpoint gets, so a probe cannot tell "no such
    // endpoint" from "not yours" (FR-TEN-05).
    if (!created) throw new NotFoundException("no such webhook endpoint");

    const deadline = Date.now() + TEST_EVENT_TIMEOUT_MS;
    for (;;) {
      const result = await testDeliveryResult(this.db, created.deliveryId);
      if (result?.settled) {
        return {
          delivered: result.delivered,
          status: result.status,
          latency_ms: result.latencyMs,
          error: result.error,
          event_id: created.eventId,
        };
      }
      if (Date.now() >= deadline) {
        // NOT an HTTP error, and the distinction is the contract's. A non-2xx from
        // the customer means the test succeeded in finding out; this means the
        // platform did not find out, and the `error` says which. Answering 500
        // would conflate "we could not run the test" with "your endpoint is
        // unhealthy", and the second is what a customer would read.
        return {
          delivered: false,
          status: null,
          latency_ms: null,
          error:
            "no attempt was reported within 10s — is the dispatcher running?",
          event_id: created.eventId,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, TEST_EVENT_POLL_MS));
    }
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.repo.deleteEndpoint(id);
    if (!deleted) throw new NotFoundException("no such webhook endpoint");
  }

  private assertDeliverableUrl(raw: string): void {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new UnprocessableEntityException("url must be a valid absolute URL");
    }
    if (parsed.protocol !== "https:") {
      throw new UnprocessableEntityException(
        "url must use https — a signature over a plaintext channel protects the body, not the reader",
      );
    }
    const host = parsed.hostname;
    if (BLOCKED_HOSTS.test(host) || BLOCKED_RANGES.some((r) => r.test(host))) {
      throw new UnprocessableEntityException(
        "url must not point at a loopback, link-local or private address",
      );
    }
  }

  private assertEventTypes(types: string[]): void {
    if (!Array.isArray(types) || types.length === 0) {
      throw new UnprocessableEntityException(
        "event_types must list at least one event type",
      );
    }
  }
}
