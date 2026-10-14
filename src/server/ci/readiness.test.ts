import { describe, expect, it } from "vitest";
import { CI_TABLE_LABELS, type CiTableKey, type CiTables } from "@/server/db/schema";
import { NotConfiguredError } from "@/server/ci/errors";
import { pendingRequiredTables, pendingTables, REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { createRefusingRepository, REPOSITORY_METHOD_TABLES } from "@/server/ci/repository";
import { FULL_SCOPE } from "@/lib/ci/rules";

// Pure tests only. They use injected table maps, and call only READ methods of the
// refusing repository, which throws before any data access: no Databricks, no writes.

const KEYS = Object.keys(CI_TABLE_LABELS) as CiTableKey[];
const ref = { catalog: "c", schema: "s", table: "t" };
const allPending = Object.fromEntries(KEYS.map((k) => [k, null])) as CiTables;
const allConfigured = Object.fromEntries(KEYS.map((k) => [k, ref])) as CiTables;

describe("pendingTables / requireTablesConfigured", () => {
  it("names every pending table, once each, in the order asked", () => {
    expect(pendingTables(["lookups", "users", "lookups"], allPending)).toEqual(["Lookups", "CI Users"]);
  });

  it("leaves out tables that are configured", () => {
    const tables = { ...allPending, users: ref } as CiTables;
    expect(pendingTables(["users", "competitiveInfo"], tables)).toEqual(["Competitive Info"]);
  });

  it("refuses with the pending-configuration message and lists the tables as details", () => {
    let error: unknown;
    try {
      requireTablesConfigured(REQUIRES.competitiveInfoList, allPending);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotConfiguredError);
    const e = error as NotConfiguredError;
    expect(e.message).toBe("CI database table configuration is pending: CI User Management, Competitive Info.");
    expect(e.status).toBe(503);
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.details).toEqual(["CI User Management", "Competitive Info"]);
  });

  it("passes when every table is configured", () => {
    expect(() => requireTablesConfigured(REQUIRES.importRun, allConfigured)).not.toThrow();
  });

  it("falls back to a generic pending message when no table is named", () => {
    expect(new NotConfiguredError().message).toBe("CI database table configuration is pending.");
  });
});

describe("per-route table requirements", () => {
  it("only name known tables, and every route needs the user table first (ci_user_management; the legacy admin routes still name users)", () => {
    for (const [route, keys] of Object.entries(REQUIRES)) {
      expect(keys.includes("userManagement" as never) || keys.includes("users" as never), route).toBe(true);
      for (const k of keys) expect(KEYS, `${route} -> ${k}`).toContain(k);
    }
  });

  it("does not require the import staging table (no screen uses it yet)", () => {
    for (const keys of Object.values(REQUIRES)) expect(keys as readonly string[]).not.toContain("importStaging");
    expect(pendingRequiredTables(allPending)).not.toContain("Import Staging");
  });

  it("matches what each screen actually reads (from the service calls)", () => {
    expect(REQUIRES.competitiveInfoList).toEqual(["userManagement", "competitiveInfo"]);
    expect(REQUIRES.competitiveInfoAudit).toContain("auditTrail");
    expect(REQUIRES.competitiveInfoRecord).toContain("changeNotes");
    // Reference data (customer fabs, competitor products, ...) is read from ci_lookup_dependent now.
    expect(REQUIRES.competitiveInfoSave).toEqual(expect.arrayContaining(["changeNotes", "auditTrail", "lookups", "dependentLookups"]));
    expect(REQUIRES.competitiveInfoSave as readonly string[]).not.toContain("customerFabs");
    expect(REQUIRES.referenceData).not.toContain("competitiveInfo");
    expect(REQUIRES.lookupsView).toContain("competitiveInfo"); // "in use" counts
    expect(REQUIRES.lookupsWrite).toEqual(["users", "lookups"]);
  });

  it("reports every table a screen needs when nothing is configured yet", () => {
    expect(pendingTables(REQUIRES.referenceData, allPending)).toEqual([
      "CI Users",
      "Reference Data: Customers and Fabs",
      "Reference Data: Competitors and Products",
      "Reference Data: Process Locations",
      "Reference Data: Technology Nodes",
    ]);
  });
});

describe("refusing repository (no mock, no data)", () => {
  it("declares tables for every method, all of them known", () => {
    for (const [method, keys] of Object.entries(REPOSITORY_METHOD_TABLES)) {
      expect(keys.length, method).toBeGreaterThan(0);
      for (const k of keys) expect(KEYS).toContain(k);
    }
  });

  it("refuses reads with a message naming that method's own pending tables", async () => {
    const repo = createRefusingRepository(allPending);
    await expect(repo.listLookups()).rejects.toThrow("CI database table configuration is pending: Lookups.");
    await expect(repo.findUserByEmail("someone@example.com")).rejects.toThrow("pending: CI Users.");
    await expect(repo.listRecords(FULL_SCOPE)).rejects.toThrow("pending: Competitive Info.");
    await expect(repo.getReferenceData()).rejects.toThrow(/Customers and Fabs.*Technology Nodes/);
    await expect(repo.listLookups()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("says the integration is not built when the tables are configured but no implementation exists", async () => {
    const repo = createRefusingRepository(allConfigured);
    await expect(repo.listLookups()).rejects.toThrow("The Databricks integration for Lookups has not been implemented yet.");
    await expect(repo.listLookups()).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
