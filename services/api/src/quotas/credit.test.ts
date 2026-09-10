import { describe, expect, it } from "vitest";

import { creditFor, highWaterMark } from "./credit";

describe("creditFor — what a report is worth", () => {
  it("credits the whole total on a connection's first report", () => {
    expect(creditFor(17, 0)).toBe(17);
  });

  it("credits the difference on a later report", () => {
    expect(creditFor(20, 17)).toBe(3);
  });

  it("credits NOTHING for a replay", () => {
    // The property that lets the gateway retry without thinking about it.
    expect(creditFor(17, 17)).toBe(0);
  });

  it("credits nothing for a report that arrives out of order", () => {
    // A delayed report carrying an older total must not subtract from a bill.
    expect(creditFor(12, 17)).toBe(0);
  });

  it("repays a lost report through the next one", () => {
    // Reports at 5, 10, 15. The middle one never arrives. The tenant is still
    // charged 15, because totals do not depend on the reports in between.
    let credited = 0;
    for (const reported of [5, /* 10 lost */ 15]) {
      credited += creditFor(reported, credited);
    }
    expect(credited).toBe(15);
  });

  it("charges the same whether every report arrives or only the last one", () => {
    const all = [3, 6, 9, 12].reduce((c, r) => c + creditFor(r, c), 0);
    const last = creditFor(12, 0);
    expect(all).toBe(last);
  });
});

describe("highWaterMark — what the row stores afterwards", () => {
  it("advances on a higher total", () => {
    expect(highWaterMark(20, 17)).toBe(20);
  });

  it("does not move for a replay or a late low report", () => {
    expect(highWaterMark(17, 17)).toBe(17);
    expect(highWaterMark(12, 17)).toBe(17);
  });

  it("never lowers a figure, whatever a caller claims", () => {
    // Belt and braces against the one mistake this file exists to prevent.
    for (const reported of [0, 1, 16]) {
      expect(highWaterMark(reported, 17)).toBe(17);
    }
  });
});
