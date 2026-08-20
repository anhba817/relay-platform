import { describe, expect, it } from "vitest";

import { disableNotification, type DisableFacts } from "./mailer";

// What the message SAYS, decided without a server (chapter 3.8, FR-WHK-07). The
// integration suite proves the same properties about what Mailpit received; this
// one is where the wording is designed.

const facts: DisableFacts = {
  endpointUrl: "https://hooks.acme.example/relay",
  environmentName: "production",
  disabledAt: new Date("2026-08-20T09:15:00.000Z"),
  runStartedAt: new Date("2026-08-20T08:45:00.000Z"),
  attempts: 20,
  lastStatus: 503,
  lastError: null,
};

describe("the disablement notification", () => {
  it("says what happened, to what, and what to do about it", () => {
    const mail = disableNotification(facts);
    expect(mail.subject).toContain("hooks.acme.example");
    expect(mail.subject.toLowerCase()).toContain("disabled");
    // The four facts an operator needs before they can act: which endpoint,
    // which environment, how long it was failing, and what it was failing with.
    expect(mail.text).toContain("https://hooks.acme.example/relay");
    expect(mail.text).toContain("production");
    expect(mail.text).toContain("20");
    expect(mail.text).toContain("503");
    // And the instruction. A notification that reports a state without naming
    // the action is a notification that generates a support ticket.
    expect(mail.text.toLowerCase()).toContain("re-enable");
  });

  it("reports a transport failure as a transport failure, not as status null", () => {
    // `last_status` is nullable because a connection that never completed has no
    // status. Printing "null" would be the literal truth and useless.
    const mail = disableNotification({
      ...facts,
      lastStatus: null,
      lastError: "ECONNREFUSED",
    });
    expect(mail.text).not.toContain("null");
    expect(mail.text).toContain("ECONNREFUSED");
  });

  it("CARRIES NO SECRET, NO KEY AND NO CREDENTIAL (FR-WHK-07)", () => {
    // The whole message, scanned as one string. This is the assertion the
    // chapter is about: an email is the least controlled artefact Relay
    // produces — it lands in an inbox, gets forwarded, sits in a mail archive
    // nobody has threat-modelled, and is read over someone's shoulder on a
    // train. A signing secret in an outage notification is a signing secret in
    // all of those places.
    //
    // The facts deliberately include none of those things, which is the point:
    // `DisableFacts` is the seam, and it cannot carry a secret because it has
    // no field for one. The scan is what stops that staying true by accident.
    const mail = disableNotification(facts);
    const whole = `${mail.subject}\n${mail.text}`;

    // Values, absolutely. Each of these IS a credential wherever it appears.
    for (const pattern of [
      /rk_(live|test|svc)_/i, // an API key or the internal credential
      /whsec_/i, // a webhook signing secret
      /eyJ[A-Za-z0-9_-]{10,}/, // a JWT, by its base64 header
      /[A-Za-z0-9+/]{40,}={0,2}/, // any long base64 run
    ]) {
      expect(whole).not.toMatch(pattern);
    }

    // Labels, only where a value follows one. The message SAYS the word
    // "secret" — it tells the reader there isn't one in here and where to find
    // the real thing — and a scan that forbade the word would be a scan that
    // forces prose to talk around the subject while a base64 blob three lines
    // down goes unnoticed. What is forbidden is a label with a value attached.
    for (const pattern of [
      /\bsecret\b\s*[:=]/i,
      /\bpassword\b\s*[:=]/i,
      /\bapi[_ -]?key\b\s*[:=]/i,
      /\btoken\b\s*[:=]/i,
    ]) {
      expect(whole).not.toMatch(pattern);
    }

    // And the label scan can fire, which is the check the scan itself needs.
    expect("signing secret: whsec_abc").toMatch(/\bsecret\b\s*[:=]/i);
  });

  it("names the endpoint by URL and never by its id", () => {
    // A UUID is not something a customer can act on. It also travels: an id in
    // an email is an internal identifier in an external place, and the URL says
    // the same thing to a human who has to go and fix it.
    const mail = disableNotification(facts);
    expect(mail.text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});
