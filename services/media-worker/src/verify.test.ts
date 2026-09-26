import { afterEach, describe, expect, it, vi } from "vitest";

import { gifOf, pngOf } from "./fixtures.js";
import type { StoreConfig } from "./store.js";
import { judge, probe, PROBE_BYTES, type PendingObject } from "./verify.js";

const store: StoreConfig = {
  endpoint: "http://store.invalid",
  accessKey: "k",
  secretKey: "s",
  bucket: "b",
};

const object = (over: Partial<PendingObject> = {}): PendingObject => ({
  id: "a",
  object_key: "k/a",
  mime_type: "image/png",
  declared_bytes: 100,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Two responses in order: the `HEAD`, then the ranged `GET`. */
const storeAnswers = (
  head: { status: number; headers?: Record<string, string> },
  body?: Uint8Array,
): ReturnType<typeof vi.fn> => {
  const calls = vi.fn(async (_url: string, init?: { method?: string }) =>
    init?.method === "HEAD"
      ? new Response(null, {
          status: head.status,
          ...(head.headers ? { headers: head.headers } : {}),
        })
      : new Response(body ? (body.slice() as unknown as BodyInit) : null, {
          status: body ? 206 : 404,
        }),
  );
  vi.stubGlobal("fetch", calls);
  return calls as unknown as ReturnType<typeof vi.fn>;
};

describe("reading what the store holds", () => {
  it("answers nothing at all for an object the store does not have", async () => {
    // FR-009 AS AN ABSENCE, and the commonest outcome by far: 91.6% of the lane's
    // `pending` rows have no bytes behind them. A 404 is "not yet", never "rejected".
    storeAnswers({ status: 404 });
    expect(await probe(object(), store)).toBeNull();
  });

  it("READS THE PREFIX, NOT THE OBJECT — 64 KiB of a file that may be 100 MB", async () => {
    const png = pngOf(64, 32);
    const calls = storeAnswers(
      { status: 200, headers: { "content-length": String(png.length) } },
      png,
    );
    await probe(object({ declared_bytes: png.length }), store);
    const ranged = calls.mock.calls.find(
      (c) => (c[1] as { headers?: Record<string, string> }).headers?.["range"],
    );
    expect(
      (ranged![1] as { headers: Record<string, string> }).headers["range"],
    ).toBe(`bytes=0-${PROBE_BYTES - 1}`);
  });

  it("carries the store's own byte count and the bytes' own type", async () => {
    const png = pngOf(64, 32);
    const found = (await probe(
      object({ declared_bytes: png.length }),
      (storeAnswers(
        {
          status: 200,
          headers: {
            "content-length": String(png.length),
            // THE STORE ECHOES THE CLIENT'S CLAIM. Measured against MinIO: a presigned
            // PUT of twelve MP4 bytes sent with `content-type: image/png` answers HEAD
            // with `image/png`. The probe carries this header nowhere.
            "content-type": "video/mp4",
            "last-modified": "Sun, 20 Sep 2026 17:02:53 GMT",
          },
        },
        png,
      ),
      store)!,
    ))!;
    expect(found.bytes).toBe(png.length);
    expect(found.detectedType).toBe("image/png");
    expect(found.width).toBe(64);
    expect(found.height).toBe(32);
    expect(found.uploadedAt?.toISOString()).toBe("2026-09-20T17:02:53.000Z");
  });
});

describe("the declaration, judged", () => {
  const found = (over: Partial<Parameters<typeof judge>[1]> = {}) => ({
    bytes: 100,
    detectedType: "image/png" as string | null,
    uploadedAt: null,
    ...over,
  });

  it("passes a declaration the bytes agree with", () => {
    expect(judge(object(), found({ width: 8, height: 8 }))).toEqual({
      verdict: "ready",
      verified_bytes: 100,
      verified_type: "image/png",
      width: 8,
      height: 8,
    });
  });

  it("REJECTS A SIZE MISMATCH IN EITHER DIRECTION", () => {
    // A client that declared one byte and uploaded five megabytes is the case FR-MED-03
    // exists for; one that declared more than it sent is the same defect with the sign
    // flipped. Both are a row whose `declared_bytes` is a lie, and the storage quota was
    // charged against that number.
    expect(judge(object(), found({ bytes: 5_000_000 }))).toMatchObject({
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_bytes: 5_000_000,
    });
    expect(judge(object(), found({ bytes: 3 }))).toMatchObject({
      verdict: "rejected",
      verified_bytes: 3,
    });
  });

  it("REJECTS A TYPE MISMATCH, which is the half the store's header cannot see", () => {
    expect(
      judge(object({ mime_type: "image/png" }), found({ detectedType: "video/mp4" })),
    ).toMatchObject({
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_type: "video/mp4",
    });
  });

  it("DOES NOT REJECT A TYPE IT COULD NOT NAME, and records the declaration instead", () => {
    // Turning "I do not recognise this" into "this is a lie" is how a verifier starts
    // refusing valid files. FR-MED-02 already refused everything outside the ten allowed
    // types at slot time, so a prefix this cannot name is truncated or unusual, not
    // hostile.
    const verdict = judge(object(), found({ detectedType: null }));
    expect(verdict.verdict).toBe("ready");
    expect(verdict).toMatchObject({ verified_type: "image/png" });
  });

  it("accepts the MP4 pair in both directions and nothing else", () => {
    expect(
      judge(object({ mime_type: "audio/mp4" }), found({ detectedType: "video/mp4" })),
    ).toMatchObject({ verdict: "ready" });
    expect(
      judge(object({ mime_type: "image/gif" }), found({ detectedType: "image/png" })),
    ).toMatchObject({ verdict: "rejected" });
  });

  it("omits dimensions rather than recording zeros for a file that has none", () => {
    // A `width` of 0 is a claim about an image that is 0 pixels wide. An absent column
    // says the probe did not answer, which is the true thing — and it is the same
    // distinction 4.4 paid for when `LowCardinality(String)` could not say "absent".
    const verdict = judge(object({ mime_type: "audio/wav" }), found({
      detectedType: "audio/wav",
    }));
    expect(verdict).not.toHaveProperty("width");
    expect(verdict).not.toHaveProperty("height");
  });

  it("SIZE IS CHECKED BEFORE TYPE, and a file that fails both reports the size", () => {
    // The order matters for what the audit record says, not for the answer: both are
    // `declaration_mismatch`, and FR-005 does not ask the platform to distinguish the
    // two kinds — because the customer sees neither.
    const verdict = judge(
      object({ mime_type: "image/png", declared_bytes: 1 }),
      found({ bytes: 100, detectedType: "image/gif" }),
    );
    expect(verdict).toMatchObject({
      verdict: "rejected",
      verified_bytes: 100,
      verified_type: "image/gif",
    });
  });

  it("a GIF declared as a PNG is caught even at exactly the right size", () => {
    // The size half alone cannot see this: a client that declares the right number of
    // bytes and uploads a different format passes every check that reads a header.
    const gif = gifOf(8, 8);
    expect(
      judge(
        object({ mime_type: "image/png", declared_bytes: gif.length }),
        found({ bytes: gif.length, detectedType: "image/gif" }),
      ),
    ).toMatchObject({ verdict: "rejected", reason: "declaration_mismatch" });
  });
});
