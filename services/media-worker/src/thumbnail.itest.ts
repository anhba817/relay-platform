import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withRendition } from "./rendition.js";
import { getObject, putObject, storeConfigFromEnv, type StoreConfig } from "./store.js";
import { thumbnailOf } from "./thumbnail.js";
import type { Probe } from "./verify.js";

// FR-MED-05 AGAINST A REAL STORE, WITH BYTES A DECODER WILL ACCEPT.
//
// `thumbnail.test.ts` covers PNG and GIF in the Docker-free lane, because those are the
// two fixtures in this repository that decode. The other two allowed types — JPEG and
// WebP — have no usable fixture: `jpegOf` is a header with no entropy-coded scan and
// `webpOf` a `VP8` header with no stream. **This file makes real ones with the decoder
// itself**, which is circular for testing the encoder and not circular for testing the
// path: what is under test here is the fetch, the resize and the write, not libvips.
describe("a rendition, end to end against the store", () => {
  let store: StoreConfig;
  const written: string[] = [];

  /** A real image of the given type, encoded by sharp. */
  const imageOf = async (
    format: "jpeg" | "png" | "webp" | "gif",
    width: number,
    height: number,
  ): Promise<Uint8Array> => {
    const sharp = (await import("sharp")).default;
    const base = sharp({
      create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
    });
    const out = await (format === "jpeg"
      ? base.jpeg()
      : format === "png"
        ? base.png()
        : format === "webp"
          ? base.webp()
          : base.gif()
    ).toBuffer();
    return new Uint8Array(out);
  };

  /** Put an object in the store and return the key, so the fetch path is exercised
   * rather than handed a buffer it already has. */
  const upload = async (bytes: Uint8Array, contentType: string): Promise<string> => {
    const key = `thumbnail-itest/${randomUUID()}`;
    expect(await putObject(store, key, bytes, contentType), "the store refused a PUT").toBe(
      true,
    );
    written.push(key);
    return key;
  };

  const probe = (over: Partial<Probe> = {}): Probe =>
    ({ bytes: 0, detectedType: "image/png", uploadedAt: new Date(), ...over }) as Probe;

  const ready = { verdict: "ready", verified_bytes: 1, verified_type: "image/png" } as const;

  beforeAll(() => {
    // THE LANE'S PUBLISHED ADDRESS, the way `verify.itest.ts` resolves it. The host
    // lane sets no `RELAY_MINIO_ENDPOINT` — only `compose.yaml` does, for containers —
    // so a suite that passed `process.env` straight in refused to start and reported
    // **10 skipped**, which is a counted line that means nothing ran.
    store = storeConfigFromEnv({
      RELAY_MINIO_ENDPOINT: process.env["RELAY_MINIO_ENDPOINT"] ?? "http://localhost:9100",
    });
  });

  afterAll(() => {
    // NO CLEANUP, AND THE FIRST DRAFT'S ATTEMPT AT ONE WAS A BOUNDARY VIOLATION: it
    // imported `deleteObject` from the api's source, which this service must not reach
    // into and which the compiler refused outright. The worker has four readers and one
    // writer and no delete, deliberately — deletion is the api's, on the internal seam.
    //
    // So these objects stay. They are confined to a `thumbnail-itest/` prefix and have
    // no rows, so nothing in the platform will ever look at them; they are lane debris
    // of the same kind `reset-lane.mjs` exists for and does not touch.
    expect(written.length, "the suite wrote nothing, so it tested nothing").toBeGreaterThan(0);
  });

  it.each(["png", "jpeg", "webp", "gif"] as const)(
    "makes a bounded thumbnail of a real %s",
    async (format) => {
      const bytes = await imageOf(format, 1200, 900);
      const outcome = await thumbnailOf(bytes);
      expect(outcome.kind).toBe("made");
      if (outcome.kind !== "made") return;
      expect([outcome.width, outcome.height]).toEqual([320, 240]);
    },
  );

  it("fetches, resizes and writes — and the bytes come back out of the store", async () => {
    const parent = await imageOf("jpeg", 1600, 1200);
    const key = await upload(parent, "image/jpeg");

    const decision = await withRendition(
      { ...ready, verified_type: "image/jpeg" },
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      probe({ detectedType: "image/jpeg", width: 1600, height: 1200 }),
      store,
    );

    expect(decision.verdict).toBe("ready");
    if (decision.verdict !== "ready") return;
    expect(decision.rendition, "no rendition for a 1600x1200 jpeg").toBeDefined();
    expect(decision.rendition!.width).toBe(320);
    expect(decision.rendition!.height).toBe(240);
    written.push(decision.rendition!.object_key);

    // READ THE STORE, NOT THE RETURN VALUE. SC-005 asks whether the bytes are there;
    // trusting the object this function just built would assert that it returned what
    // it returned.
    const stored = await getObject(store, decision.rendition!.object_key, 10 * 1024 * 1024);
    expect(stored, "the rendition's key holds nothing").not.toBeNull();
    expect(stored!.length).toBe(decision.rendition!.bytes);
    const back = await thumbnailOf(stored!);
    // A 320x240 WebP is inside the bound, so re-rendering it is a no-op — which is also
    // a check that what came back is a decodable image and not an error page.
    expect(back.kind).toBe("within-bound");
  });

  it("makes nothing, and no bytes, for an image already inside the bound", async () => {
    const parent = await imageOf("png", 200, 150);
    const key = await upload(parent, "image/png");

    const decision = await withRendition(
      ready,
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      probe({ width: 200, height: 150 }),
      store,
    );
    expect(decision.verdict).toBe("ready");
    if (decision.verdict !== "ready") return;
    expect(decision.rendition).toBeUndefined();
    expect(decision.rendition_failed_reason, "within-bound is not a failure").toBeUndefined();
  });

  it("fetches anyway when the probe could not read the dimensions", async () => {
    // THE THIRD STATE, AND IT IS AN ORDINARY CAMERA JPEG. A maximal APP1 segment pushes
    // `SOF0` past the worker's 64 KiB probe window, so `dimensionsOf` returns null while
    // the whole file decodes fine. A two-state gate would skip exactly these.
    const base = await imageOf("jpeg", 1200, 900);
    const app1 = new Uint8Array(0xffff + 2);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1[2] = 0xff;
    app1[3] = 0xff;
    app1.fill(0x41, 4);
    const withExif = new Uint8Array(base.length + app1.length);
    withExif.set(base.subarray(0, 2), 0);
    withExif.set(app1, 2);
    withExif.set(base.subarray(2), 2 + app1.length);
    const key = await upload(withExif, "image/jpeg");

    const decision = await withRendition(
      { ...ready, verified_type: "image/jpeg" },
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      // width and height ABSENT, which is what the real probe reports for this file
      probe({ detectedType: "image/jpeg" }),
      store,
    );
    expect(decision.verdict).toBe("ready");
    if (decision.verdict !== "ready") return;
    expect(
      decision.rendition,
      "a camera JPEG with a big EXIF block got no thumbnail",
    ).toBeDefined();
    written.push(decision.rendition!.object_key);
  });

  it("records a reason, and writes nothing, when the bytes will not decode", async () => {
    const key = await upload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), "image/png");
    const decision = await withRendition(
      ready,
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      probe({ width: 4000, height: 3000 }),
      store,
    );
    expect(decision.verdict).toBe("ready");
    if (decision.verdict !== "ready") return;
    expect(decision.rendition).toBeUndefined();
    expect(decision.rendition_failed_reason).toBe("decode_failed");
  });

  it("leaves a rejected verdict alone and writes nothing (FR-009)", async () => {
    const parent = await imageOf("png", 1200, 900);
    const key = await upload(parent, "image/png");
    const decision = await withRendition(
      { verdict: "rejected", reason: "scan_failed", verified_bytes: parent.length },
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      probe({ width: 1200, height: 900 }),
      store,
    );
    expect(decision).toEqual({
      verdict: "rejected",
      reason: "scan_failed",
      verified_bytes: parent.length,
    });
  });

  it("makes nothing for audio, without a failure reason", async () => {
    const key = await upload(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), "audio/mpeg");
    const decision = await withRendition(
      ready,
      { id: randomUUID(), environment_id: randomUUID(), object_key: key },
      probe({ detectedType: "audio/mpeg" }),
      store,
    );
    expect(decision.verdict).toBe("ready");
    if (decision.verdict !== "ready") return;
    expect(decision.rendition).toBeUndefined();
    expect(decision.rendition_failed_reason).toBeUndefined();
  });
});
