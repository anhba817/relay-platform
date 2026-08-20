import { createTransport, type Transporter } from "nodemailer";

// The disablement notification (chapter 3.8, FR-021, FR-WHK-07).
//
// TWO PIECES, SEPARATED ON PURPOSE. `disableNotification` turns facts into a
// message and touches nothing — no SMTP, no clock, no database — so what the
// email SAYS is decided by a unit test. `createMailer` is the part that talks to
// a server, and it is thin enough that there is nothing in it to get wrong.
//
// THE SEAM IS THE SECURITY CONTROL. `DisableFacts` has no field for a secret, so
// the mailer cannot leak one it was never given — FR-021 is enforced by the
// shape of the input rather than by a filter over the output, and a filter is
// what you write when the shape already lost. The test scans the message anyway,
// because "cannot happen" is a claim and a scan is evidence.

/** Everything the message is allowed to know. */
export interface DisableFacts {
  endpointUrl: string;
  environmentName: string;
  disabledAt: Date;
  runStartedAt: Date;
  attempts: number;
  /** Null when the endpoint never answered — a refused connection has no status. */
  lastStatus: number | null;
  lastError: string | null;
}

export interface Mail {
  subject: string;
  text: string;
}

/** How long the failing run went on, in whole minutes. Rounded up, because "0
 * minutes" reads as "no time passed" for a run that lasted forty seconds. */
function durationMinutes(from: Date, to: Date): number {
  return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 60_000));
}

export function disableNotification(facts: DisableFacts): Mail {
  const host = new URL(facts.endpointUrl).host;
  // What it was failing WITH. A status when there was one, the transport error
  // when the request never got far enough to have one. Printing `null` would be
  // accurate and unusable.
  const cause =
    facts.lastStatus !== null
      ? `HTTP ${facts.lastStatus}`
      : (facts.lastError ?? "no response");
  const minutes = durationMinutes(facts.runStartedAt, facts.disabledAt);

  return {
    subject: `Relay disabled your webhook endpoint at ${host}`,
    text: [
      `Relay has stopped delivering webhooks to:`,
      ``,
      `    ${facts.endpointUrl}`,
      ``,
      `Environment: ${facts.environmentName}`,
      `Failing for: ${minutes} minute${minutes === 1 ? "" : "s"}`,
      `Attempts:    ${facts.attempts}`,
      `Last result: ${cause}`,
      ``,
      // The instruction, not just the state. A notification that reports a
      // problem without naming the action is a notification that becomes a
      // support ticket.
      `Deliveries will not resume on their own. Fix the endpoint, then`,
      `re-enable it from the webhook settings for this environment.`,
      ``,
      // Said explicitly, because the absence is the thing a reader will wonder
      // about. Nothing here identifies the endpoint beyond its own URL.
      `This message contains no signing secret and no credential. If you`,
      `need the secret to verify deliveries, read it from the dashboard.`,
    ].join("\n"),
  };
}

export const DEFAULT_SMTP_URL = "smtp://localhost:1025";

export interface Mailer {
  send: (to: string, mail: Mail) => Promise<void>;
  close: () => void;
}

/** A full URL with a default here, never a host and a port the caller composes.
 * `harness.ts` records what the other shape costs: a caller that builds its own
 * URL is a second source of truth for an address, which is how the e2e suite
 * first failed. */
export function createMailer(
  url: string = process.env["RELAY_SMTP_URL"] ?? DEFAULT_SMTP_URL,
  from = "Relay <relay@relay.example>",
): Mailer {
  const transport: Transporter = createTransport(url);
  return {
    send: async (to, mail) => {
      await transport.sendMail({ from, to, ...mail });
    },
    close: () => {
      transport.close();
    },
  };
}
