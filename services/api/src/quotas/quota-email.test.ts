import { describe, expect, it } from "vitest";

import { quotaThreshold } from "./quota-email";

const facts = (over: Partial<Parameters<typeof quotaThreshold>[0]> = {}) =>
  quotaThreshold({
    environmentName: "Fleet Ops / production",
    period: "2026-08-01",
    dimension: "messages",
    threshold: 80,
    quota: 10_000,
    usageAtCrossing: 8_000,
    hardCapInForce: true,
    ...over,
  });

describe("the threshold email", () => {
  it("names the environment as a person would, the figures, and the month", () => {
    const mail = facts();
    expect(mail.subject).toBe(
      "Relay: Fleet Ops / production has used 80% of its monthly messages quota",
    );
    expect(mail.text).toContain("8000 of 10000 messages for August 2026 — 80%");
  });

  it("says nothing was refused below 100%", () => {
    expect(facts().text).toContain("Nothing has been refused");
  });

  it("says sends are refused, and when they resume, at 100% with a hard cap", () => {
    const mail = facts({ threshold: 100, usageAtCrossing: 10_000 });
    expect(mail.text).toContain("Sends are now being refused");
    expect(mail.text).toContain("September 2026");
  });

  it("says nothing was refused at 100% of a SOFT threshold", () => {
    // An email that threatens a suspension which will not happen teaches the
    // reader that the warnings are noise.
    const mail = facts({ threshold: 100, hardCapInForce: false });
    expect(mail.text).toContain("Nothing has been refused");
    expect(mail.text).not.toContain("Sends are now being refused");
  });

  it("rolls the resume month into the next year in December", () => {
    const mail = facts({ threshold: 100, period: "2026-12-01" });
    expect(mail.text).toContain("January 2027");
  });

  it("spells active_users as a phrase", () => {
    expect(facts({ dimension: "active_users" }).subject).toContain(
      "monthly active users quota",
    );
  });
});
