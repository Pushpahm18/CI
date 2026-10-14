import { describe, expect, it, vi } from "vitest";
import type { CiUserRecordRaw } from "@/types/ci-api";

// The repository and the user table are replaced by fakes, so this never reads or writes any table.
const record = vi.fn<(email: string, name: string, options?: { role?: string }) => Promise<void>>();
vi.mock("@/server/ci/login-history/repository", () => ({
  getLoginHistoryRepository: () => ({ list: async () => [], record }),
}));

let users: CiUserRecordRaw[] | null = [];
let usersFail = false;
vi.mock("@/server/ci/databricks/user-records", () => ({
  getUserRecordStore: () =>
    users === null
      ? null
      : {
          list: async () => {
            if (usersFail) throw new Error("warehouse down");
            return users!;
          },
        },
}));

const { recordLoginEvent } = await import("@/server/ci/login-history/capture");

const rec = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
  id: "u1", userName: "Ann Lee", email: "ann@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All",
  status: "Active", lastSignIn: "", isActive: true, ...over,
});

describe("recordLoginEvent (called from the sign-in event)", () => {
  it("records the successful sign-in with the person's CI role", async () => {
    users = [rec({})];
    record.mockResolvedValueOnce(undefined);
    await recordLoginEvent("Ann@Example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("Ann@Example.com", "Ann Lee", { role: "Corporate Marketing" });
  });

  it("records an Account Team user with their role", async () => {
    users = [rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' })];
    record.mockResolvedValueOnce(undefined);
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("ann@example.com", "Ann Lee", { role: "Account Team" });
  });

  it("still records a Microsoft sign-in by someone with no CI record, with no role", async () => {
    users = [rec({ email: "someone.else@example.com" })];
    record.mockResolvedValueOnce(undefined);
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("ann@example.com", "Ann Lee", { role: undefined });
  });

  it("gives no role to a deactivated or invalid record, and when the user table is unavailable", async () => {
    users = [rec({ isActive: false, status: "Off-boarded" })];
    record.mockResolvedValue(undefined);
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("ann@example.com", "Ann Lee", { role: undefined });
    users = null;
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("ann@example.com", "Ann Lee", { role: undefined });
    users = [rec({})];
    usersFail = true;
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record).toHaveBeenLastCalledWith("ann@example.com", "Ann Lee", { role: undefined });
    usersFail = false;
  });

  it("only ever records a sign-in: there is no way to pass another event", async () => {
    users = [rec({})];
    record.mockResolvedValueOnce(undefined);
    await recordLoginEvent("ann@example.com", "Ann Lee");
    expect(record.mock.calls.at(-1)).toHaveLength(3);
    expect(recordLoginEvent.length).toBe(2);
  });

  it("never throws, so it can never block a sign-in", async () => {
    users = [rec({})];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    record.mockRejectedValueOnce(new Error("boom"));
    await expect(recordLoginEvent("ann@example.com", "Ann Lee")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
