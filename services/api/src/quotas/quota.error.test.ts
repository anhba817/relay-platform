import { describe, expect, it } from "vitest";

import { QuotaExceededError, type Dimension } from "./quota.error";

const err = (over: Partial<ConstructorParameters<typeof QuotaExceededError>[0]> = {}) =>
  new QuotaExceededError({
    dimension: "messages",
    usage: 10_000,
    quota: 10_000,
    period: "2026-08-01",
    ...over,
  });

describe("the refusal a developer reads", () => {
  it("names the dimension, the usage, the quota and the resume date, in that order", () => {
    expect(err().publicMessage()).toBe(
      "monthly message quota exhausted: 10000 of 10000 for 2026-08-01; " +
        "sends resume on 2026-09-01",
    );
  });

  it("rolls the resume date into the next year in December", () => {
    expect(err({ period: "2026-12-01" }).resumesOn()).toBe("2027-01-01");
  });

  it("says active user rather than active_users", () => {
    // The code is machine-facing and the message is not.
    expect(err({ dimension: "active_users" }).publicMessage()).toContain(
      "monthly active user quota exhausted",
    );
  });

  it("carries the four fields a caller needs to build a response", () => {
    const e = err();
    expect(e.dimension).toBe("messages");
    expect(e.usage).toBe(10_000);
    expect(e.quota).toBe(10_000);
    expect(e.period).toBe("2026-08-01");
  });
});

describe("the message names the right noun and the right operation (3.11)", () => {
  const at = (dimension: Dimension) =>
    new QuotaExceededError({
      dimension,
      usage: 50_000,
      quota: 50_000,
      period: "2026-08-01",
    }).publicMessage();

  it("names connection-minutes, not 'active user'", () => {
    // The regression this replaces: `dimension === "messages" ? … : "active
    // user"` sent every non-message dimension down the else arm, and `Dimension`
    // is `keyof QuotaConfig`, so adding the config key widened the type without
    // a single compiler complaint.
    expect(at("connection_minutes")).toContain("monthly connection-minute quota");
    expect(at("connection_minutes")).not.toContain("active user");
  });

  it("says CONNECTIONS resume, because sends never stopped", () => {
    expect(at("connection_minutes")).toContain("connections resume on 2026-09-01");
    expect(at("messages")).toContain("sends resume on 2026-09-01");
    expect(at("active_users")).toContain("sends resume on 2026-09-01");
  });

  it("keeps the other two dimensions exactly as chapter 3.10 shipped them", () => {
    expect(at("messages")).toBe(
      "monthly message quota exhausted: 50000 of 50000 for 2026-08-01; sends resume on 2026-09-01",
    );
    expect(at("active_users")).toBe(
      "monthly active user quota exhausted: 50000 of 50000 for 2026-08-01; sends resume on 2026-09-01",
    );
  });
});
