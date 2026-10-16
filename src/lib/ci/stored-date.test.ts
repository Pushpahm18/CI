import { describe, expect, it } from "vitest";
import { formatStoredDate } from "@/lib/ci/stored-date";

describe("formatStoredDate (created / modified date display)", () => {
  it("shows the stored date as 06-Jan-2024, never shifting the day", () => {
    expect(formatStoredDate("2024-01-06T00:00:00.000Z")).toBe("06-Jan-2024");
    expect(formatStoredDate("2024-01-06T23:59:59.000Z")).toBe("06-Jan-2024");
    expect(formatStoredDate("2026-04-02")).toBe("02-Apr-2026");
    expect(formatStoredDate("2026-12-31 08:05:00")).toBe("31-Dec-2026");
  });

  it("adds the stored time (HH:mm) when asked, as stored", () => {
    expect(formatStoredDate("2024-01-06T14:30:05.123Z", true)).toBe("06-Jan-2024 14:30");
    expect(formatStoredDate("2024-01-06T00:00:00.000Z", true)).toBe("06-Jan-2024 00:00");
    expect(formatStoredDate("2026-04-02", true)).toBe("02-Apr-2026");
  });

  it("returns anything that is not a recognisable date exactly as stored", () => {
    for (const v of ["", "n/a", "06/01/2024", "2024-13-01", "2024-00-10", "2024-01-06T10:00:00+05:30"]) expect(formatStoredDate(v, true)).toBe(v);
  });
});
