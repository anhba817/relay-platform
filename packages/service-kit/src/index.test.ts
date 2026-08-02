import { describe, expect, it } from "vitest";

import { createLogger, newRequestId } from "./index.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("structured logger (NFR-OBS-01)", () => {
  it("emits one valid JSON object per line with the required fields", () => {
    const lines: string[] = [];
    const logger = createLogger("test-svc", (line) => lines.push(line));
    logger.log("info", "hello", { request_id: "r-1" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "info",
      service: "test-svc",
      msg: "hello",
      request_id: "r-1",
    });
    expect(Number.isNaN(Date.parse(parsed.time as string))).toBe(false);
  });

  it("keeps levels and extra fields intact through the sink", () => {
    const lines: string[] = [];
    const logger = createLogger("test-svc", (line) => lines.push(line));
    logger.log("error", "boom", { status: 500 });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.status).toBe(500);
  });
});

describe("request ids (EIR-API-05)", () => {
  it("are UUID-shaped and unique", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});
