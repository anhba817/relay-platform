import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTACHMENT_SCHEMES,
  ATTACHMENT_URL_MAX,
  MAX_ATTACHMENTS,
  attachmentSchema,
  refineTextAndAttachments,
} from "./attachments.js";

// T010 (chapter 3.24). THE EXACT KEY SET AND EVERY REFUSAL, on `codes.test.ts`'s
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

describe("the attachment shape (FR-002 (3.24), FR-003b (3.24), FR-020 (3.24))", () => {
  it("accepts the url arm and pins its exact key set", () => {
    const parsed = attachmentSchema.parse(url());
    expect(Object.keys(parsed).sort()).toEqual(["kind", "type", "url"]);
  });

  it("refuses an unknown key rather than dropping it", () => {
    // `strictObject`, so a field added on one side of a rolling deploy fails loudly on
    // the other instead of vanishing.
    expect(attachmentSchema.safeParse(url({ caption: "hi" })).success).toBe(false);
  });

  it("accepts the three kinds and refuses a fourth (FR-002 (3.24))", () => {
    for (const kind of ["image", "audio", "video"]) {
      expect(attachmentSchema.safeParse(url({ kind })).success, kind).toBe(true);
    }
    for (const kind of ["file", "document", "IMAGE", ""]) {
      expect(attachmentSchema.safeParse(url({ kind })).success, kind).toBe(false);
    }
  });
});

describe("the scheme rule is not z.url() (FR-004 (3.24), R7)", () => {
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

  it("publishes the allowed set, so a caller can read it (FR-004 (3.24))", () => {
    expect([...ATTACHMENT_SCHEMES]).toEqual(["http:", "https:"]);
  });
});

describe("the bounds (FR-005 (3.24), FR-023 (3.24))", () => {
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

  it("accepts exactly ten in a list and refuses eleven (FR-005 (3.24))", () => {
    // The list bound belongs to whichever schema carries the array, so this asserts the
    // constant does what the send schemas will ask of it.
    const list = z.array(attachmentSchema).max(MAX_ATTACHMENTS);
    expect(list.safeParse(Array.from({ length: 10 }, () => url())).success).toBe(true);
    expect(list.safeParse(Array.from({ length: 11 }, () => url())).success).toBe(false);
  });
});

describe("the media arm refuses and SAYS SO (FR-003 (3.24), FR-003a (3.24))", () => {
  it("names hosted media rather than calling the field invalid", () => {
    const result = attachmentSchema.safeParse({ type: "media", media_id: "m_1" });
    expect(result.success).toBe(false);
    // THE MESSAGE, not the failure. A one-arm union also fails here — with "Invalid
    // discriminator value. Expected 'url'", which is the sentence FR-003a forbids. This
    // assertion is the only thing that can tell the two apart, and `session.ts:1447`
    // forwards exactly this string to a socket client.
    expect(result.error!.issues[0]!.message).toMatch(/hosted media is not available/i);
  });

  it("leaves room for §4.14 rather than requiring a new discriminator (FR-020 (3.24))", () => {
    // The arm exists, so §4.14 replaces its body. What this pins is that `type` already
    // accepts the string: a future accept is a change to one arm and not to the union's
    // shape.
    const result = attachmentSchema.safeParse({ type: "media", media_id: "m_1" });
    expect(result.error!.issues[0]!.code).not.toBe("invalid_union_discriminator");
  });
});

describe("the text-and-attachments pair rule (FR-019 (3.24), FR-019b (3.24))", () => {
  const schema = z
    .object({ text: z.string(), attachments: z.array(attachmentSchema).optional() })
    .superRefine(refineTextAndAttachments);

  it("accepts an attachments-only message with an empty text (FR-019 (3.24))", () => {
    expect(schema.safeParse({ text: "", attachments: [url()] }).success).toBe(true);
  });

  it("accepts text with no attachments", () => {
    expect(schema.safeParse({ text: "words" }).success).toBe(true);
  });

  it("refuses neither text nor attachments, and names a field (FR-019b (3.24))", () => {
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
