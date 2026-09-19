import { HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { ProtocolErrorFilter } from "./protocol-error.filter";

// THE LADDER, PROBED WITH THROWS THAT NAME NOTHING (FR-018, T027b).
//
// Every rung exists for a thrower that forgot. A thrower that remembers its code never
// reaches the ternary at all, so a test that goes through `protocolError` proves the
// opposite of what this file is for — it proves the NAMED path works, which is the path
// that was never broken.
//
// THIS IS THE PROBE THAT WOULD HAVE CAUGHT THE TWO THE FILTER ALREADY DOCUMENTS. A 400
// answering `internal_error` shipped until chapter 2.2 and a 403 until the credentials
// chapter, and in both cases the code was reachable, the tests were green, and nobody
// threw an unnamed exception at that status.

interface Captured {
  statusCode: number;
  body: { code: string; message: string; docs_url: string; field?: string };
}

/** A response and a host, both as small as the filter's use of them. */
function capture(exception: unknown): Captured {
  let written = "";
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    getHeader: () => "req-1",
    end: (chunk: string) => {
      written = chunk;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;

  new ProtocolErrorFilter().catch(exception, host);
  return { statusCode: res.statusCode, body: JSON.parse(written) as Captured["body"] };
}

describe("the error filter's status ladder", () => {
  // The four statuses hosted media introduced, and the four the ladder already had.
  const RUNGS: [number, string][] = [
    [400, "invalid_request"],
    [401, "unauthorized"],
    [402, "quota_exceeded"],
    [403, "forbidden"],
    [404, "not_found"],
    [413, "media_too_large"],
    [415, "media_type_not_allowed"],
    [503, "service_unavailable"],
  ];

  it.each(RUNGS)("answers %i with %s, from a throw that names nothing", (status, code) => {
    const captured = capture(new HttpException("something went wrong", status));
    expect(captured.statusCode).toBe(status);
    expect(captured.body.code).toBe(code);
  });

  // AND THE NEGATIVE HALF, which is the assertion the two historical defects needed.
  // "Every rung answers something" is satisfied by a ladder that answers
  // `internal_error` everywhere, so the distinct claim is that none of them does.
  it.each(RUNGS)("does not fall %i through to internal_error", (status) => {
    expect(capture(new HttpException("x", status)).body.code).not.toBe("internal_error");
  });

  it("still falls an unmapped status through, which is the honest answer there", () => {
    // 418 means nothing in this platform. A ladder that invented a code for it would be
    // the same lie one rung over.
    expect(capture(new HttpException("x", 418)).body.code).toBe("internal_error");
    expect(capture(new Error("not an HttpException")).body.code).toBe("internal_error");
  });

  it("lets a named code win over the rung", () => {
    // `media_storage_unavailable` and `service_unavailable` are both 503 answers, and
    // the specific one is right whenever the thrower knows which store went away.
    const captured = capture(
      new HttpException({ code: "media_storage_unavailable", message: "gone" }, 503),
    );
    expect(captured.body.code).toBe("media_storage_unavailable");
  });

  it("refuses a code the registry does not define, and falls back to the rung", () => {
    // `HttpException` is public, so a thrower can put any string in `code`. This filter
    // is the last place that can notice before the string becomes a `docs_url`.
    const captured = capture(new HttpException({ code: "not_a_real_code", message: "x" }, 415));
    expect(captured.body.code).toBe("media_type_not_allowed");
    expect(captured.body.docs_url).not.toContain("not_a_real_code");
  });
});
