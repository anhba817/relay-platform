import {
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
  HttpCode,
  UseGuards,
} from "@nestjs/common";

import {
  internalDeliveryOutcomeRequestSchema,
  internalExpandRequestSchema,
  type InternalDeliveryOutcomeRequest,
  type InternalDeliveryOutcomeResponse,
  type InternalExpandRequest,
  type InternalExpandResponse,
} from "@relay/protocol";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { Db } from "../db/client";
import {
  DeliveryNotFoundError,
  deliveryMaterial,
  expandEventToDeliveries,
  recordAttemptOutcome,
  replayDeadLetter,
} from "../db/repository";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";

// The dispatcher's only road to state (chapter 3.5, constitution IV).
//
// "Only the API service writes to PostgreSQL… Other services obtain writes and
// backfill reads via the API service's internal endpoints." The dispatcher owns
// no database, so everything it needs is here — and that constraint is not a
// workaround, it is the reason chapter 3.4's claim-and-effect-in-one-transaction
// pattern stops applying and the chapter has something to say.
//
// `@Accepts("platform")` and nothing else. These routes reach EVERY environment,
// which is exactly why no tenant credential may use them: an API key is scoped to
// one environment by construction, and a route that accepted one here would
// either be useless to the dispatcher or would have to ignore the scope — and
// ignoring a tenant scope is the shape a cross-tenant hole takes.
@Controller("internal/dispatch")
@UseGuards(CredentialGuard)
@Accepts("platform")
export class DispatchController {
  constructor(@Inject("DB") private readonly db: Db) {}

  /** One event becomes one delivery per matching endpoint — claimed, so it
   * happens exactly once however often the broker redelivers (research R2). */
  @Post("expand")
  @HttpCode(200)
  async expand(
    @Body(new ZodValidationPipe(internalExpandRequestSchema))
    body: InternalExpandRequest,
  ): Promise<InternalExpandResponse> {
    const result = await expandEventToDeliveries(this.db, {
      eventId: body.event_id,
      environmentId: body.environment_id,
      type: body.type,
      payload: body.payload,
    });
    return { created: result.created, duplicate: result.duplicate };
  }

  /** Everything needed to sign and post one delivery, including the DECRYPTED
   * signing secrets — one, or two during a rotation window.
   *
   * This is the one response in the platform that carries a customer credential
   * in plaintext. Internal network only, never logged at any level, and held by
   * the dispatcher for the duration of a signature and no longer
   * (contracts/dispatcher.md §The secret crosses a process boundary). */
  @Post("material")
  @HttpCode(200)
  async material(@Body() body: { delivery_id?: string }) {
    if (!body?.delivery_id) throw new NotFoundException("no such delivery");
    const material = await deliveryMaterial(this.db, body.delivery_id);
    if (!material) throw new NotFoundException("no such delivery");
    return material;
  }

  /** What happened when we posted. Idempotent on `(delivery_id, attempt)`: the
   * dispatcher posts, reports, then acknowledges, so a crash in the last gap
   * means this arrives twice. The POST may duplicate — the customer absorbs that
   * on the event id — but the SCHEDULE must not advance twice for one attempt. */
  @Post("outcome")
  @HttpCode(200)
  async outcome(
    @Body(new ZodValidationPipe(internalDeliveryOutcomeRequestSchema))
    body: InternalDeliveryOutcomeRequest,
  ): Promise<InternalDeliveryOutcomeResponse> {
    try {
      // Spread rather than assign: `exactOptionalPropertyTypes` is on, so an
      // explicit `undefined` is not the same as an absent key — and the
      // difference is real here, because "no status" means the attempt never got
      // a response at all.
      const result = await recordAttemptOutcome(this.db, {
        deliveryId: body.delivery_id,
        attempt: body.attempt,
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
      return {
        outcome: result.outcome,
        ...(result.nextAttemptAt
          ? { next_attempt_at: result.nextAttemptAt.toISOString() }
          : {}),
      };
    } catch (error) {
      if (error instanceof DeliveryNotFoundError) {
        throw new NotFoundException("no such delivery");
      }
      throw error;
    }
  }

  /** Put a dead-lettered delivery back on the schedule, with the endpoint's
   * CURRENT url and secret — which is automatic, because delivery material is
   * read at send time rather than frozen into the delivery.
   *
   * Internal for now. FR-WHK-04 also asks for dead letters to be inspectable and
   * replayable FROM THE DASHBOARD, and the dashboard is chapter 5.2's; this is
   * the mechanism that screen will call, built where it can be tested today. */
  @Post("replay")
  @HttpCode(200)
  async replay(@Body() body: { dead_letter_id?: string }) {
    if (!body?.dead_letter_id) throw new NotFoundException("no such dead letter");
    const replayed = await replayDeadLetter(this.db, body.dead_letter_id);
    if (!replayed) throw new NotFoundException("no such dead letter");
    return { replayed: true };
  }
}
