import { z } from "zod";

/** THE ATTACHMENT SHAPE (chapter 3.24, FR-MSG-11's P2 half).
 *
 * Its own module, following `presence.ts`, `typing.ts` and `revision.ts`: a shape both
 * doors import, plus the constants that bound it. Two schemas that happen to agree are
 * the defect this chapter is trying not to repeat — `idem_key` against
 * `idempotency_key` is what that looks like three chapters later — so the bound lives
 * here once and the send schemas import it.
 *
 * TWO ARMS, AND THE SECOND ONE REFUSES. §4.14 will add hosted media, and FR-003 says a
 * `media_id` attachment must be refused with a code of its own until it exists. That
 * refusal has to happen at BOTH doors, and the doors do not share a controller:
 * `messages.controller.ts` validates with `sendMessageBodySchema` and
 * `internal.controller.ts` — every socket send — with `internalSendRequestSchema`. The
 * only thing they share is this file.
 *
 * A one-arm union refuses `{"type":"media"}` with zod's own discriminator message,
 * measured against 4.4.3:
 *
 *     one arm    "Invalid discriminator value. Expected 'url'"
 *     two arms   "hosted media is not available yet — …"
 *
 * The first says THE FIELD IS INVALID, which is the one thing FR-003a forbids by name:
 * `media_id` is published in FR-MSG-11 and a customer reading that clause will send one.
 * The second arm carries the sentence, and `session.ts:1447` already forwards
 * `issues[0].message` beside `invalid_frame`, so the socket gets it for free.
 *
 * WHAT IT COSTS is one word of FR-003b, which asks that §4.14 "add an arm rather than
 * change one". This arm exists now and refuses, so §4.14 replaces its body. That is a
 * smaller change than introducing a discriminator later, which is the thing FR-003b was
 * written to prevent, and it is stated here rather than left as a contradiction. */

/** FR-005. Ten, and both doors import this rather than spelling it. */
export const MAX_ATTACHMENTS = 10;

/** FR-023. FR-MSG-11 states no length, so this is the chapter's own bound and it takes
 * the platform's only precedent for a stored URL: `users.avatar_url`, capped at 2,048
 * since chapter 3.16. A second number for the same kind of value would be two limits a
 * customer has to remember. */
export const ATTACHMENT_URL_MAX = 2048;

/** FR-004, and it is a list rather than a regex because the list is the requirement.
 *
 * `z.url()` IS NOT THIS CHECK. Measured against zod 4.4.3, it accepts `javascript:`,
 * `data:`, `file:`, `ftp:` and `vbscript:` — research R7 ran the table rather than
 * reading the docs. A URL validator that accepts `javascript:alert(1)` is not a
 * scheme rule, so the scheme is asserted separately and by name. */
export const ATTACHMENT_SCHEMES = ["http:", "https:"] as const;

const urlWithAllowedScheme = z
  .string()
  .min(1)
  .max(ATTACHMENT_URL_MAX)
  .refine(
    (value) => {
      // `new URL` and not a prefix match. A prefix match passes
      // `https:/example.test` and `httpsx://…` depending on how it is written, and the
      // parser is the thing that already knows what a scheme is.
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return (ATTACHMENT_SCHEMES as readonly string[]).includes(parsed.protocol);
    },
    { message: "url must use the http or https scheme" },
  );

/** The arm §4.14 will replace. It parses the shape so the DISCRIMINATOR matches — that
 * is what makes zod run this arm's refinement instead of answering with its own generic
 * message — and then refuses unconditionally. */
const mediaArm = z
  .strictObject({
    type: z.literal("media"),
    media_id: z.string().min(1),
  })
  .refine(() => false, {
    message:
      "hosted media is not available yet — attach an http or https url instead (FR-MSG-11 §4.14)",
  });

const urlArm = z.strictObject({
  type: z.literal("url"),
  // FR-002. Three kinds, and a fourth is a refusal rather than a passthrough.
  kind: z.enum(["image", "audio", "video"]),
  url: urlWithAllowedScheme,
});

/** `strictObject` on both arms, so an unknown key is a refusal rather than a silent
 * drop — the argument `membershipFabricSchema` and `revisionFabricSchema` both make: a
 * field added on one side of a rolling deploy fails loudly on the other instead of
 * vanishing. */
export const attachmentSchema = z.discriminatedUnion("type", [urlArm, mediaArm]);

/** The type the read paths cast the column to. `messages.attachments` is a bare
 * `jsonb()` with no `.$type<>()`, so drizzle infers `unknown` on select and every read
 * site says what it is with `sql<Attachment[] | null>`. That is a cast and not a check;
 * `data-model.md` argues why the claim lives per read site rather than once in the
 * schema. */
export type Attachment = z.infer<typeof attachmentSchema>;

/** THE TEXT-AND-ATTACHMENTS PAIR RULE, in one place because it is one rule.
 *
 * FR-019: an attachments-only message is accepted and stores `text = ""` rather than a
 * null, so chapter 3.23's tombstone predicate — `text === null` — is untouched.
 * FR-019b: a message with neither text nor attachments is still refused.
 *
 * Those are two halves of one decision about a PAIR of fields, and writing it into
 * either send schema would put it on one door. `messages.schema.ts` is imported by
 * exactly one file and never by the socket path, so a `superRefine` there is a rule the
 * socket does not have — and the refusal is the half that goes missing, because
 * relaxing the text bound is what makes the permission work and nothing then enforces
 * the floor.
 *
 * Applied with `.superRefine`, so both doors get the same issue and the same `field`. */
export function refineTextAndAttachments(
  // `| undefined` SPELLED OUT, and not just `?`. This package compiles with
  // `exactOptionalPropertyTypes`, under which `attachments?: T[]` means "absent or a
  // T[]" and refuses a caller whose own type is `T[] | undefined`. Both send schemas
  // infer exactly that, so the optional marker alone would reject both callers — which
  // the compiler said before either of them existed.
  value: {
    text?: string | null | undefined;
    attachments?: readonly unknown[] | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const hasText = typeof value.text === "string" && value.text.length > 0;
  const hasAttachments = Array.isArray(value.attachments) && value.attachments.length > 0;
  if (hasText || hasAttachments) return;
  ctx.addIssue({
    code: "custom",
    // `path` names `text`, not the pair. The api's pipe joins `path` with dots into the
    // error's `field`, and a caller who sent neither is most likely to have sent text
    // they thought was non-empty. Naming the pair would give a field no request has.
    path: ["text"],
    message: "text must not be empty unless the message carries at least one attachment",
  });
}
