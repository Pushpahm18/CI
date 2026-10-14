import { describe, expect, it } from "vitest";
import { formatModifiedOn } from "@/lib/ci/format-when";

describe("formatModifiedOn", () => {
  it("shows day, abbreviated month, year and a 24-hour time", () => {
    // Built from local parts so the expectation holds in any time zone.
    const d = new Date(2026, 8, 8, 23, 37);
    expect(formatModifiedOn(d.toISOString())).toMatch(/^08 Sep(t)? 2026, 23:37$/);
  });

  it("is blank for a missing or unreadable time instead of showing 'Invalid Date'", () => {
    expect(formatModifiedOn("")).toBe("");
    expect(formatModifiedOn(undefined)).toBe("");
    expect(formatModifiedOn(null)).toBe("");
    expect(formatModifiedOn("not a date")).toBe("");
  });
});
