import { describe, expect, it } from "vitest";

import { quotaThreshold, type CrossingFacts } from "./quota-email";

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

describe("the third dimension's copy (chapter 3.11)", () => {
  const facts = (over: Partial<CrossingFacts> = {}): CrossingFacts => ({
    environmentName: "Fleet Ops / production",
    period: "2026-08-01",
    dimension: "connection_minutes",
    threshold: 100,
    quota: 50_000,
    usageAtCrossing: 50_000,
    hardCapInForce: true,
    ...over,
  });

  it("names the dimension the way a bill would, not the way a column does", () => {
    const mail = quotaThreshold(facts());
    expect(mail.subject).toContain("connection-minutes");
    expect(mail.subject).not.toContain("connection_minutes");
  });

  it("says CONNECTIONS are refused, not sends", () => {
    // Naming the wrong operation sends somebody looking for a fault in the half
    // that is working.
    const mail = quotaThreshold(facts());
    expect(mail.text).toContain("New connections are now being refused");
    expect(mail.text).toContain("close code 4008");
    expect(mail.text).not.toMatch(/^Sends are now being refused/m);
  });

  it("says what keeps working, because most of it does", () => {
    const mail = quotaThreshold(facts());
    expect(mail.text).toContain("Connections already open stay open");
    expect(mail.text).toContain("sends and history reads over REST are unaffected");
  });

  it("at 100% of a SOFT threshold, says nothing was refused", () => {
    // An email that threatens a suspension which will not happen teaches the
    // reader that the warnings are noise.
    const mail = quotaThreshold(facts({ hardCapInForce: false }));
    expect(mail.text).toContain("Nothing has been refused");
    expect(mail.text).not.toContain("close code 4008");
  });

  it("below 100%, warns without naming any consequence", () => {
    const mail = quotaThreshold(facts({ threshold: 80, usageAtCrossing: 40_000 }));
    expect(mail.text).toContain("Nothing has been refused");
    expect(mail.subject).toContain("80%");
  });

  it("leaves the other two dimensions saying exactly what they said", () => {
    for (const dimension of ["messages", "active_users"]) {
      const mail = quotaThreshold(facts({ dimension }));
      expect(mail.text).toContain("Sends are now being refused with `quota_exceeded`.");
      expect(mail.text).not.toContain("4008");
    }
  });
});
