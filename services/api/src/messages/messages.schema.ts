import {
  attachmentSchema,
  MAX_ATTACHMENTS,
  MESSAGE_TEXT_MAX,
  refineTextAndAttachments,
} from "@relay/protocol";
import { z } from "zod";

// The send body (chapter 2.2). FR-MSG-01 fixes the limits: text up to
// 8,000 characters, metadata up to 4 KB of JSON — the length check lands
// with FR-EMJ-02's code-point counting in the emoji chapter; today the
// character bound is the honest approximation, recorded as such.
export const sendMessageBodySchema = z
  .strictObject({
    /** `.min(1)` REMOVED in the attachments chapter (FR-019), and the floor moved to the
     * refinement below rather than disappearing. An attachments-only message is a
     * photograph with no caption, and it stores `text = ""` rather than a null so
     * The revisions chapter's tombstone predicate — `text === null` — is untouched. */
    text: z.string().max(MESSAGE_TEXT_MAX),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Chapter 2.3 (FR-MSG-04): the client's idempotency key — minted at send
    // time (FR-SDK-06), optional because server-originated messages may not
    // carry one. The partial unique index (DR-03) ignores NULLs.
    idempotency_key: z.string().uuid().optional(),
    /** WHO IS SENDING (FR-MSG-15, FR-008).
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
    /** FR-001 and FR-005. OPTIONAL on the way in — a caller may send none — and the
     * bound is IMPORTED rather than spelled, because the socket's door imports the same
     * constant and two schemas that happen to agree are what `idem_key` against
     * `idempotency_key` looks like three chapters later. */
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  })
  /** THE PAIR RULE, IMPORTED AND NOT WRITTEN HERE (FR-019, FR-019b).
   *
   * Text may be empty when at least one attachment is present, and a body with neither
   * is refused. That is one rule about a PAIR of fields, and this file is imported by
   * exactly one other — never by the socket path, which validates with
   * `internalSendRequestSchema`. A `superRefine` written here would be a rule the
   * socket does not have, and the half that goes missing is the REFUSAL: relaxing the
   * text bound is what makes the permission work, and nothing then enforces the floor. */
  .superRefine(refineTextAndAttachments);

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

/** The edit body (FR-001).
 *
 * THE SAME MAXIMUM AS THE SEND BODY'S `text` AND A DIFFERENT FLOOR, which is the whole
 * history of this field in one line. FR-MSG-01 fixes the maximum for a message and an
 * edited message is still a message, so both import `MESSAGE_TEXT_MAX` and neither
 * spells it.
 *
 * THE FLOORS DIVERGED IN the attachments chapter AND MUST STAY DIVERGED. This paragraph used to say
 * the field was "written as a reference to that shape" — it was
 * `sendMessageBodySchema.shape.text` — and that is what broke: FR-019 removed the send's
 * `.min(1)` so an attachments-only message could carry empty text, and the edit's floor
 * went with it silently, because the types are identical either way. An edit has no
 * attachments field to justify empty text. 3.24 separated them into two literals; this
 * feature shares the number they agree on and leaves the rule they do not.
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
/** The edit body (FR-001). ITS OWN BOUND, AND NO LONGER THE SEND'S.
 *
 * This read `sendMessageBodySchema.shape.text` until chapter 3.24, which was correct
 * while the two agreed. Then FR-019 removed `.min(1)` from the send so an
 * attachments-only message could carry no caption — and the edit inherited the
 * relaxation through this reference. **An edit has no attachments field**, so the pair
 * rule that restores the send's floor cannot restore this one: `PATCH` with `text: ""`
 * became a 200 and the revisions chapter's own test caught it.
 *
 * Spelled out rather than derived. Two schemas that happen to agree are a defect this
 * chapter has already recorded twice; two schemas that must DIFFER cannot share a
 * reference at all. */
export const editMessageBodySchema = z.strictObject({
  /** THE MAXIMUM IS SHARED; THE FLOOR IS NOT, AND THAT IS THE WHOLE POINT (FR-008).
   *
   * The attachments chapter found this field defined as `sendMessageBodySchema.shape.text`, so
   * relaxing the send's `.min(1)` for attachments-only messages silently relaxed the
   * edit's too — and an edit has no attachments field to restore its floor. The compiler
   * could not see it: the types are identical either way.
   *
   * Importing a NUMBER cannot bring that back. `MESSAGE_TEXT_MAX` is FR-MSG-01's bound,
   * common to all four doors; `.min(1)` is this schema's own rule and stays written here
   * where it can be read. */
  text: z.string().min(1).max(MESSAGE_TEXT_MAX),
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
