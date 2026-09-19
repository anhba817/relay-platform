import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTACHMENT_SCHEMES,
  ATTACHMENT_URL_MAX,
  MAX_ATTACHMENTS,
  attachmentSchema,
  forwardedAttachmentSchema,
  refineTextAndAttachments,
} from "./attachments.js";

// T010. THE EXACT KEY SET AND EVERY REFUSAL, on `codes.test.ts`'s
// precedent: pinning the set is what makes a change to it a decision rather than an
// accident.
//
// The scheme cases are the ones that matter. Research R7 ran `z.url()` against seven
// inputs and it accepted `javascript:`, `data:`, `file:`, `ftp:` and `vbscript:` — so a
// test that only tries `https:` proves that the happy path works and nothing else.

const url = (over: Record<string, unknown> = {}) => ({
  type: "url" as const,
  kind: "image" as const,
  url: "https://example.test/a.png",
  ...over,
});

describe("the attachment shape (FR-002, FR-003b, FR-020)", () => {
  it("accepts the url arm and pins its exact key set", () => {
    const parsed = attachmentSchema.parse(url());
    expect(Object.keys(parsed).sort()).toEqual(["kind", "type", "url"]);
  });

  it("refuses an unknown key rather than dropping it", () => {
    // `strictObject`, so a field added on one side of a rolling deploy fails loudly on
    // the other instead of vanishing.
    expect(attachmentSchema.safeParse(url({ caption: "hi" })).success).toBe(false);
  });

  it("accepts the three kinds and refuses a fourth (FR-002)", () => {
    for (const kind of ["image", "audio", "video"]) {
      expect(attachmentSchema.safeParse(url({ kind })).success, kind).toBe(true);
    }
    for (const kind of ["file", "document", "IMAGE", ""]) {
      expect(attachmentSchema.safeParse(url({ kind })).success, kind).toBe(false);
    }
  });
});

describe("the scheme rule is not z.url() (FR-004, R7)", () => {
  it("accepts http and https", () => {
    for (const u of ["https://example.test/a.png", "http://example.test/a.png"]) {
      expect(attachmentSchema.safeParse(url({ url: u })).success, u).toBe(true);
    }
  });

  it("refuses javascript:, data:, file: and vbscript:", () => {
    // The four R7 measured `z.url()` accepting. Each one is a separate assertion
    // because a loop that stops at the first failure would hide the other three.
    for (const u of [
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      const result = attachmentSchema.safeParse(url({ url: u }));
      expect(result.success, u).toBe(false);
    }
  });

  it("refuses ftp: and a scheme-relative url", () => {
    expect(attachmentSchema.safeParse(url({ url: "ftp://example.test/a.png" })).success).toBe(
      false,
    );
    // `new URL` cannot parse this at all, which is a refusal for a different reason and
    // worth pinning so a later parser change does not turn it into an accept.
    expect(attachmentSchema.safeParse(url({ url: "//example.test/a.png" })).success).toBe(false);
  });

  it("publishes the allowed set, so a caller can read it (FR-004)", () => {
    expect([...ATTACHMENT_SCHEMES]).toEqual(["http:", "https:"]);
  });
});

describe("the bounds (FR-005, FR-023)", () => {
  it("pins ten and 2,048", () => {
    // The numbers, not just their behaviour: both doors import these and a silent
    // change to either is a contract change.
    expect(MAX_ATTACHMENTS).toBe(10);
    expect(ATTACHMENT_URL_MAX).toBe(2048);
  });

  it("accepts a url at exactly the bound and refuses one character more", () => {
    const pad = (n: number) => "https://example.test/" + "a".repeat(n - "https://example.test/".length);
    expect(attachmentSchema.safeParse(url({ url: pad(ATTACHMENT_URL_MAX) })).success).toBe(true);
    expect(attachmentSchema.safeParse(url({ url: pad(ATTACHMENT_URL_MAX + 1) })).success).toBe(
      false,
    );
  });

  it("accepts exactly ten in a list and refuses eleven (FR-005)", () => {
    // The list bound belongs to whichever schema carries the array, so this asserts the
    // constant does what the send schemas will ask of it.
    const list = z.array(attachmentSchema).max(MAX_ATTACHMENTS);
    expect(list.safeParse(Array.from({ length: 10 }, () => url())).success).toBe(true);
    expect(list.safeParse(Array.from({ length: 11 }, () => url())).success).toBe(false);
  });
});

describe("the media arm accepts, and what it accepts is narrow (FR-001, FR-008a)", () => {
  const ID = "3f7c1a2e-0b5d-4c8a-9e61-7a0d2b4f6c81";

  it("accepts a uuid media_id", () => {
    const result = attachmentSchema.safeParse({ type: "media", media_id: ID });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "media", media_id: ID });
  });

  // THE REFUSAL THIS ARM USED TO MAKE IS GONE, ASSERTED RATHER THAN ASSUMED. Until this
  // chapter the arm carried `.refine(() => false)` and every media attachment failed with
  // "hosted media is not available yet". "We removed it" is not a property anything
  // checks — the same argument 4.10's FR-016 test was written for, in the other
  // direction.
  it("no longer refuses every media attachment", () => {
    const result = attachmentSchema.safeParse({ type: "media", media_id: ID });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/not available/i);
  });

  // `m_1` PASSED THE OLD SCHEMA AND WAS A 500 WAITING FOR THE ARM TO ACCEPT (R3). With
  // `z.string().min(1)` it reached the lookup, Postgres answered `invalid input syntax
  // for type uuid`, and the filter turned that into `internal_error` — a 500 any caller
  // could produce. The UUID is what makes it a 400 at the door.
  it("refuses a media_id that is not a uuid, at the field", () => {
    for (const bad of ["m_1", "", "not-a-uuid", "3f7c1a2e0b5d4c8a9e617a0d2b4f6c81"]) {
      const result = attachmentSchema.safeParse({ type: "media", media_id: bad });
      expect(result.success, bad).toBe(false);
      // THE PATH NAMES THE KEY, which the old arm's refusal could not: a `.refine` over
      // the whole object stops at the attachment, and a caller with ten of them is told
      // only which attachment. This says which field of it.
      expect(result.error!.issues[0]!.path, bad).toEqual(["media_id"]);
    }
  });

  it("still refuses an unknown key on the arm, rather than dropping it", () => {
    const result = attachmentSchema.safeParse({ type: "media", media_id: ID, state: "ready" });
    expect(result.success).toBe(false);
  });

  // THE DISCRIMINATOR STILL SELECTS THIS ARM, which is what makes every message above
  // about the media arm rather than about the union. A regression here would report a
  // UUID problem as "expected 'url'".
  it("selects the media arm by its discriminator", () => {
    const result = attachmentSchema.safeParse({ type: "media", media_id: "nope" });
    expect(result.error!.issues[0]!.code).not.toBe("invalid_union_discriminator");
  });
});

describe("the forwarding reader takes an arm it does not know (FR-018, FR-018d)", () => {
  const ID = "3f7c1a2e-0b5d-4c8a-9e61-7a0d2b4f6c81";

  it("accepts both arms it does know", () => {
    expect(forwardedAttachmentSchema.safeParse({ type: "media", media_id: ID }).success).toBe(true);
    expect(forwardedAttachmentSchema.safeParse(url()).success).toBe(true);
  });

  // THE POINT OF THE WHOLE TYPE. A reader that forwards must not refuse a shape its
  // writer may produce, because the two deploy separately — and the reader is the older
  // binary exactly when it matters. `attachmentSchema` refuses this and should.
  it("accepts an arm from a newer writer, where the strict union refuses it", () => {
    const future = { type: "audio_clip", clip_id: ID, duration_ms: 1200 };
    expect(attachmentSchema.safeParse(future).success).toBe(false);
    expect(forwardedAttachmentSchema.safeParse(future).success).toBe(true);
  });

  // AND IT IS NOT A FREE PASS. Permissive about the ARM, not about being an attachment:
  // without a `type` there is nothing to forward and no way to tell payload from garbage.
  it("still refuses something that is not an attachment at all", () => {
    for (const bad of [{ clip_id: ID }, "a string", 7, null, []]) {
      expect(forwardedAttachmentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the text-and-attachments pair rule (FR-019, FR-019b)", () => {
  const schema = z
    .object({ text: z.string(), attachments: z.array(attachmentSchema).optional() })
    .superRefine(refineTextAndAttachments);

  it("accepts an attachments-only message with an empty text (FR-019)", () => {
    expect(schema.safeParse({ text: "", attachments: [url()] }).success).toBe(true);
  });

  it("accepts text with no attachments", () => {
    expect(schema.safeParse({ text: "words" }).success).toBe(true);
  });

  it("refuses neither text nor attachments, and names a field (FR-019b)", () => {
    for (const value of [
      { text: "" },
      { text: "", attachments: [] },
    ]) {
      const result = schema.safeParse(value);
      expect(result.success, JSON.stringify(value)).toBe(false);
      // The api's pipe joins `path` with dots into the error's `field`, so a rule with no
      // path produces a refusal that names nothing.
      expect(result.error!.issues[0]!.path, JSON.stringify(value)).toEqual(["text"]);
    }
  });
});
