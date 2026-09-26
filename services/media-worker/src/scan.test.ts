import { describe, expect, it } from "vitest";

import { interpret, scannerConfigFromEnv } from "./scan.js";

// THE REPLY LINES ARE REAL, taken from a running ClamAV 1.5.4 over `INSTREAM` rather
// than from the protocol documentation.

describe("reading the scanner's answer", () => {
  it("reads a clean stream", () => {
    expect(interpret("stream: OK")).toEqual({ outcome: "clean" });
  });

  it.each([
    ["stream: Eicar-Test-Signature FOUND", "Eicar-Test-Signature"],
    // EICAR WITH A TRAILING NEWLINE IS A DIFFERENT SIGNATURE, measured — the engine
    // has one entry for the 68-byte string and another for the 69-byte one. A reader
    // that matched on the signature NAME rather than on `FOUND` would have called the
    // second one clean.
    ["stream: Eicar-Signature FOUND", "Eicar-Signature"],
    ["stream: Win.Test.EICAR_HDB-1 FOUND", "Win.Test.EICAR_HDB-1"],
  ])("reads %s", (reply, signature) => {
    expect(interpret(reply)).toEqual({ outcome: "infected", signature });
  });

  it("TREATS ANYTHING IT DOES NOT UNDERSTAND AS UNAVAILABLE, NEVER AS CLEAN", () => {
    // The one mistake in this file that would let an infected object reach `ready`.
    // A protocol answer the reader does not know is a reason to try again.
    for (const reply of ["", "ERROR", "INSTREAM size limit exceeded", "stream: ???"]) {
      expect(interpret(reply).outcome).toBe("unavailable");
    }
  });

  it("does not read the word OK inside a signature name as clean", () => {
    expect(interpret("stream: Doc.Dropper.OK-9 FOUND")).toMatchObject({
      outcome: "infected",
    });
  });
});

describe("where the scanner is", () => {
  it("defaults to localhost:3310, the port compose publishes", () => {
    expect(scannerConfigFromEnv({})).toMatchObject({
      host: "localhost",
      port: 3310,
    });
  });

  it("takes the container's address from the environment", () => {
    expect(
      scannerConfigFromEnv({ RELAY_CLAMAV_HOST: "clamav", RELAY_CLAMAV_PORT: "3310" }),
    ).toMatchObject({ host: "clamav", port: 3310 });
  });

  it("leaves the timeout absent rather than undefined when unset", () => {
    // `exactOptionalPropertyTypes` makes those two different things, and the default
    // lives at the call site so a caller can tell "not configured" from "configured
    // to zero".
    expect(Object.hasOwn(scannerConfigFromEnv({}), "timeoutMs")).toBe(false);
  });
});
