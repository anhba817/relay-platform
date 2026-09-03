import { z } from "zod";

// The send body (chapter 2.2). FR-MSG-01 fixes the limits: text up to
// 8,000 characters, metadata up to 4 KB of JSON — the length check lands
// with FR-EMJ-02's code-point counting in the emoji chapter; today the
// character bound is the honest approximation, recorded as such.
export const sendMessageBodySchema = z.strictObject({
  text: z.string().min(1).max(8000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Chapter 2.3 (FR-MSG-04): the client's idempotency key — minted at send
  // time (FR-SDK-06), optional because server-originated messages may not
  // carry one. The partial unique index (DR-03) ignores NULLs.
  idempotency_key: z.string().uuid().optional(),
  /** WHO IS SENDING (chapter 3.17, FR-MSG-15, FR-008).
   *
   * OPTIONAL HERE AND REQUIRED FOR ONE CREDENTIAL CLASS, which zod cannot express
   * because it cannot see who is calling. A user token's send is attributed to the
   * token's subject and naming a `user` in the body is refused; an application
   * credential must name one, because it carries no user of its own. The controller
   * resolves that per class (T029) and the service refuses what cannot be resolved.
   *
   * A CUSTOMER-SUPPLIED IDENTIFIER, not a platform id. Every other user-facing field in
   * this API names a user the way FR-USR-01 says the customer does, and a route that
   * took an internal uuid here would be the only one that did not. */
  user: z.string().min(1).max(255).optional(),
});

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

/** The edit body (chapter 3.23, FR-001).
 *
 * THE SAME BOUNDS AS THE SEND BODY'S `text`, and the same reason: FR-MSG-01 fixes them
 * for a message and an edited message is still a message. Written as a reference to that
 * shape rather than as a second `z.string().min(1).max(8000)`, so the two cannot drift
 * when FR-EMJ-02's code-point counting replaces the character bound.
 *
 * ONE FIELD, AND THE ABSENCES ARE DECISIONS:
 *
 *   no `user`             the send body takes one because an application credential
 *                         carries no user of its own. This route accepts only a user
 *                         token (FR-013a), so the caller is already named — and naming
 *                         somebody else is what `not_message_author` refuses.
 *   no `metadata`         FR-001 is about what a message SAYS. Editing metadata is a
 *                         separate capability nothing has asked for, and `strictObject`
 *                         makes adding it a decision rather than an accident.
 *   no `idempotency_key`  a retried edit sets the same text twice and appends a second
 *                         history row. FR-021 already says the platform does not compare
 *                         texts, so there is nothing here for a key to deduplicate that
 *                         the customer has not asked to happen. */
export const editMessageBodySchema = z.strictObject({
  text: sendMessageBodySchema.shape.text,
});

export type EditMessageBody = z.infer<typeof editMessageBodySchema>;

// The history query (chapter 2.4, FR-MSG-09): an opaque cursor, a
// direction, and a page size capped at 200. `limit` CLAMPS rather than
// rejects — a client asking for 500 gets 200 and a next_cursor, because
// caps exist to protect the server and a clamp does that just as well
// while leaving the client's loop logic alone.
export const historyQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  direction: z.enum(["older", "newer"]).default("older"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
