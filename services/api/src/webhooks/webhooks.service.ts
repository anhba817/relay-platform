import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { Repository, type WebhookEndpointRow } from "../db/repository";
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

@Injectable()
export class WebhooksService {
  constructor(private readonly repo: Repository) {}

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
