import { describe, expect, it } from "vitest";
import { checkDeactivate, checkReactivate, checkRoleChange } from "@/lib/ci/user-rules";
import type { CiUserRecordRaw } from "@/types/ci-api";

const u = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
  id: "x", userName: "X", email: "x@example.com", role: "Account Team", customer: '["A"]', segment: '["B"]', region: '["C"]',
  status: "Active", lastSignIn: "", isActive: true, ...over,
});
const cm1 = u({ id: "cm1", email: "cm1@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const cm2 = u({ id: "cm2", email: "cm2@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const at = u({ id: "at", email: "at@example.com" });

describe("user lock-out rules", () => {
  it("nobody can deactivate themselves or change their own role", () => {
    expect(checkDeactivate(cm1, [cm1, cm2], "CM1@example.com")).toMatch(/your own account/);
    expect(checkRoleChange(cm1, "Account Team", [cm1, cm2], "cm1@example.com")).toMatch(/your own role/);
  });

  it("the last active Corporate Marketing user cannot be deactivated or demoted", () => {
    expect(checkDeactivate(cm1, [cm1, at], "cm2@example.com")).toMatch(/At least one active Corporate Marketing/);
    expect(checkRoleChange(cm1, "Account Team", [cm1, at], "cm2@example.com")).toMatch(/At least one active Corporate Marketing/);
    // an inactive Corporate Marketing user does not count as the one that remains
    expect(checkDeactivate(cm1, [cm1, { ...cm2, isActive: false, status: "Off-boarded" }], "someone@example.com")).toMatch(/At least one/);
  });

  it("allows the change when another active Corporate Marketing user remains", () => {
    expect(checkDeactivate(cm1, [cm1, cm2], "cm2@example.com")).toBeNull();
    expect(checkRoleChange(cm1, "Account Team", [cm1, cm2], "cm2@example.com")).toBeNull();
    expect(checkDeactivate(at, [cm1, at], "cm1@example.com")).toBeNull();
    expect(checkRoleChange(at, "Account Team", [at], "at@example.com")).toBeNull();
  });

  it("refuses to deactivate an already deactivated user and to reactivate an active one", () => {
    const off = u({ isActive: false, status: "Off-boarded" });
    expect(checkDeactivate(off, [off], "cm1@example.com")).toMatch(/already deactivated/);
    expect(checkReactivate(off)).toBeNull();
    expect(checkReactivate(at)).toMatch(/already active/);
  });
});
