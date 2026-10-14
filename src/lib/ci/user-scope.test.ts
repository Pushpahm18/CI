import { describe, expect, it } from "vitest";
import { parseScopeText, reviewNotes } from "@/lib/ci/user-scope";
import { DEV_MOCK_USERS } from "@/lib/ci/dev-mock-users";
import type { CiUserRecordRaw } from "@/types/ci-api";

describe("scope display", () => {
  it("reads All, a JSON text array, blank and anything else as stored", () => {
    expect(parseScopeText("All")).toEqual({ kind: "all" });
    expect(parseScopeText('["Foo, Inc.","UMC"]')).toEqual({ kind: "list", values: ["Foo, Inc.", "UMC"] });
    expect(parseScopeText("  ")).toEqual({ kind: "empty" });
    for (const raw of ["KOR,CHN", "[]", "[1,2]", '["a",""]', "[oops"]) expect(parseScopeText(raw)).toEqual({ kind: "raw", text: raw });
  });
});

describe("review notes", () => {
  const ok = DEV_MOCK_USERS[1];
  it("a clean row has no notes; the mock set exercises every note", () => {
    expect(reviewNotes(ok, DEV_MOCK_USERS)).toEqual([]);
    expect(reviewNotes(DEV_MOCK_USERS[4], DEV_MOCK_USERS)).toContain("Active flag is empty or unreadable");
    expect(reviewNotes(DEV_MOCK_USERS[5], DEV_MOCK_USERS)).toContain("More than one active record for this email");
  });
  it("flags unknown roles, status conflicts, an invalid Account Team scope and a scoped Corporate Marketing user", () => {
    const base: CiUserRecordRaw = { ...ok };
    expect(reviewNotes({ ...base, role: "Admin" }, [])).toContain("Unrecognised role “Admin”");
    expect(reviewNotes({ ...base, status: "Disabled" }, [])).toContain("Status conflicts with the active flag");
    expect(reviewNotes({ ...base, customer: "All" }, [])).toEqual([]); // All is a valid Account Team scope
    expect(reviewNotes({ ...base, customer: "UMC,TSMC" }, []).join(" ")).toMatch(/Scope is invalid, so this user is denied access/);
    expect(reviewNotes({ ...base, role: "Corporate Marketing", customer: '["X"]' }, []).join(" ")).toMatch(/not scoped/);
  });
});
