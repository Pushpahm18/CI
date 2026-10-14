import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { CiError, ForbiddenError } from "@/server/ci/errors";
import {
  buildDependentListStatement,
  createDependentLookupStore,
  dependentListsFrom,
  fabMappingsFrom,
  rowToDependent,
  type DependentLookupRow,
} from "@/server/ci/databricks/dependent-lookups";
import { blankForm, cascadeFallbackHelp, fieldOptions } from "@/lib/ci/rules";
import { buildUserRecordsStatement, createUserRecordStore, rowToUserRecord } from "@/server/ci/databricks/user-records";
import { loadCiUserRecords, type CiUsersServiceDeps } from "@/server/ci/user-management/ci-users";
import { PENDING_FORM_SOURCES, loadAvailableFormOptions, type FormOptionsDeps } from "@/server/ci/form-options/service";
import { CI_TABLES, ciTableName } from "@/server/db/schema";
import type { LookupValue } from "@/types/ci";

// Fake table names and fakes only: nothing here opens a Databricks connection.

const identity = { email: "cm@example.com", name: "CM" } as never;

describe("dependent lookups (read-only, raw)", () => {
  it("selects the verified columns as a read-only statement", () => {
    const sql = buildDependentListStatement("c.s.t");
    expect(sql).toContain("`dependent_lookup_id`, `parent_type_1`, `parent_value_1`, `parent_type_2`, `parent_value_2`, `child_type`, `child_value`, `display_order`, `is_active`");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("returns rows exactly as stored, without interpreting any type string", async () => {
    const row = { dependent_lookup_id: "d1", parent_type_1: "AnyText", parent_value_1: "A", parent_type_2: null, parent_value_2: null, child_type: "Other", child_value: "X", display_order: "3", is_active: "true" };
    const store = createDependentLookupStore("c.s.t", { query: async () => [row, { ...row, is_active: null }] });
    const rows = await store.list();
    expect(rows[0]).toEqual({ id: "d1", parentType1: "AnyText", parentValue1: "A", parentType2: "", parentValue2: "", childType: "Other", childValue: "X", sortOrder: 3, active: true });
    expect(rows[1].active).toBe(false);
    expect(rowToDependent(row).childType).toBe("Other");
  });
});

describe("user records (read-only, raw)", () => {
  it("selects the verified columns as a read-only statement", () => {
    const sql = buildUserRecordsStatement("c.s.t");
    expect(sql).toContain("`ci_user_id`, `user_name`, `user_email`, `role_name`, `customer`, `segment`, `region`, `status`, `last_sign_in`, `is_active`, `modified_by`, `modified_on`");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("keeps status, scope and role as stored and never guesses the active flag", () => {
    const base = { ci_user_id: "u1", user_name: "Ann", user_email: "a@x.com", role_name: "Whatever", customer: '["A","B"]', segment: "All", region: "KOR,CHN", status: "Pending", last_sign_in: null };
    expect(rowToUserRecord({ ...base, is_active: "true" })).toMatchObject({ role: "Whatever", customer: '["A","B"]', region: "KOR,CHN", status: "Pending", lastSignIn: "", isActive: true });
    for (const v of [null, "", "yes", "1"]) expect(rowToUserRecord({ ...base, is_active: v }).isActive).toBeNull();
    expect(rowToUserRecord({ ...base, is_active: "false" }).isActive).toBe(false);
  });

  it("reads who last modified a record and when (an ISO time, blank when missing or unreadable)", () => {
    const base = { ci_user_id: "u1", user_email: "a@x.com", is_active: "true" };
    expect(rowToUserRecord({ ...base, modified_by: "Ann Lee", modified_on: "2026-09-08T23:37:00.000Z" })).toMatchObject({ modifiedBy: "Ann Lee", modifiedOn: "2026-09-08T23:37:00.000Z" });
    expect(rowToUserRecord({ ...base, modified_by: null, modified_on: null })).toMatchObject({ modifiedBy: "", modifiedOn: "" });
    expect(rowToUserRecord({ ...base, modified_on: "not a date" }).modifiedOn).toBe("");
  });

  it("lists several rows for one email as they are (no one-row-per-email rule)", async () => {
    const r = { ci_user_id: "u", user_email: "a@x.com", is_active: "true" };
    const store = createUserRecordStore("c.s.t", { query: async () => [{ ...r, ci_user_id: "u1" }, { ...r, ci_user_id: "u2" }] });
    expect(await store.list()).toHaveLength(2);
  });
});

describe("authorization is untouched", () => {
  it("the CI users table that drives sign-in stays pending; only the read tables are configured", () => {
    expect(ciTableName("users")).toBeNull();
    expect(ciTableName("userManagement")).toBe("corp_marketing_dev.ci.ci_user_management");
    expect(ciTableName("dependentLookups")).toBe("corp_marketing_dev.ci.ci_lookup_dependent");
    expect(CI_TABLES.users).toBeNull();
  });
});

describe("ci-users service", () => {
  const make = (over: Partial<CiUsersServiceDeps> = {}) => {
    const deps: CiUsersServiceDeps = { requireTables: vi.fn(), requireConnected: vi.fn(), authorize: vi.fn(async () => ({})), list: vi.fn(async () => []), ...over };
    return deps;
  };

  it("reads only after the table, connection and authorization checks", async () => {
    const deps = make();
    expect(await loadCiUserRecords(identity, deps)).toEqual({ users: [] });
    const denied = make({ authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(loadCiUserRecords(identity, denied)).rejects.toBeInstanceOf(ForbiddenError);
    expect(denied.list).not.toHaveBeenCalled();
  });

  it("hides database error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = (await loadCiUserRecords(identity, make({ list: async () => { throw new Error("PERMISSION_DENIED dapiSECRET"); } })).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });
});

describe("form options", () => {
  const lookups: LookupValue[] = [
    { id: "1", category: "Quarter", value: "Q1", sortOrder: 1, active: true },
    { id: "2", category: "Wafer Size", value: '300mm (12")', sortOrder: 1, active: true },
  ];
  const make = (over: Partial<FormOptionsDeps> = {}): FormOptionsDeps => ({
    requireTables: vi.fn(),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({})),
    repository: () => ({ listLookups: async () => lookups }),
    dependentLists: async () => ({ customerFabs: [], competitorProducts: [], processLocations: [], technologyNodes: [], entries: [], issues: [] }),
    ...over,
  });

  it("offers the connected lists including Wafer Size, and names every pending source", async () => {
    const res = await loadAvailableFormOptions(identity, make());
    expect(res.lookups.map((l) => l.category)).toEqual(["Quarter", "Wafer Size"]);
    expect(res.reference.customers).toEqual([]);
    expect(res.pendingSources).toEqual(PENDING_FORM_SOURCES);
    expect(res.pendingSources.join(" ")).not.toMatch(/Wafer Size/);
  });

  it("fills the cascades from the dependent mappings and the Customer list from ci_lookup, so the form dropdowns populate", async () => {
    const rows: DependentLookupRow[] = [
      { id: "1", parentType1: "Top Competitor", parentValue1: "TEL", parentType2: "", parentValue2: "", childType: "Product Name", childValue: "Trias", sortOrder: 1, active: true },
      { id: "2", parentType1: "Served Market", parentValue1: "DRAM", parentType2: "", parentValue2: "", childType: "Process Location", childValue: "STI", sortOrder: 1, active: true },
      { id: "3", parentType1: "Customer", parentValue1: "Micron", parentType2: "Fab Location", parentValue2: "Micron Lehi", childType: "Fab Region", childValue: "North America", sortOrder: 1, active: true },
      { id: "4", parentType1: "Customer", parentValue1: "Micron", parentType2: "Served Market", parentValue2: "DRAM", childType: "Technology Node", childValue: "1alpha", sortOrder: 1, active: true },
    ];
    const withCustomer: LookupValue[] = [...lookups, { id: "9", category: "Customer", value: "Micron", sortOrder: 1, active: true }];
    const res = await loadAvailableFormOptions(identity, make({ repository: () => ({ listLookups: async () => withCustomer }), dependentLists: async () => dependentListsFrom(rows) }));
    expect(res.reference.customers).toEqual(["Micron"]);
    expect(res.pendingSources).toEqual([]);
    const ctx = { lookups: res.lookups, reference: res.reference, user: null };
    expect(fieldOptions("productName", { ...blankForm(), topCompetitor: "TEL" }, ctx)).toEqual(["Trias"]);
    expect(fieldOptions("processLocation", { ...blankForm(), servedMarket: "DRAM" }, ctx)).toEqual(["STI"]);
    expect(fieldOptions("fabLocation", { ...blankForm(), customer: "Micron" }, ctx)).toEqual(["Micron Lehi"]);
    expect(fieldOptions("technologyNode", { ...blankForm(), customer: "Micron", servedMarket: "DRAM" }, ctx)).toEqual(["1alpha"]);
  });

  it("is refused when the caller is not allowed", async () => {
    const deps = make({ authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(loadAvailableFormOptions(identity, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Fab Location -> Fab Region single-row mapping", () => {
  const row = (over: Partial<DependentLookupRow> = {}): DependentLookupRow => ({
    id: "d", parentType1: "Customer", parentValue1: "UMC", parentType2: "Fab Location", parentValue2: "Fab 12A", childType: "Fab Region", childValue: "TWN", sortOrder: 1, active: true, ...over,
  });

  it("derives the Fab Location list and its region from the same active row, ordered by display_order within a customer", () => {
    const { fabs, issues } = fabMappingsFrom([
      row({ parentValue2: "B Fab", sortOrder: 2 }),
      row({ parentValue2: "A Fab", sortOrder: 1, childValue: "CHN" }),
      row({ parentValue1: "Intel", parentValue2: "Z Fab", childValue: "US" }),
    ]);
    expect(issues).toEqual([]);
    expect(fabs).toEqual([
      { customer: "Intel", fabLocation: "Z Fab", fabRegion: "US" },
      { customer: "UMC", fabLocation: "A Fab", fabRegion: "CHN" },
      { customer: "UMC", fabLocation: "B Fab", fabRegion: "TWN" },
    ]);
  });

  it("ignores inactive rows, NULL flags and rows of any other relationship", () => {
    const { fabs } = fabMappingsFrom([
      row({ active: false }),
      row({ parentType1: "Served Market", parentValue1: "DRAM" }),
      row({ childType: "Process Location" }),
      row({ parentType2: "Technology Node" }),
      row({ parentType1: "customer" }), // exact strings only
    ]);
    expect(fabs).toEqual([]);
  });

  it("never invents a placeholder: a row without a region (or customer / fab) is left out and reported", () => {
    const { fabs, issues } = fabMappingsFrom([row({ childValue: "" }), row({ parentValue2: "" }), row({ parentValue1: "" })]);
    expect(fabs).toEqual([]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/has no Fab Region and was ignored/);
    expect(JSON.stringify(fabs)).not.toMatch(/Not Assigned/);
  });

  it("enforces one active mapping per Customer + Fab Location: duplicates are both left out and reported", () => {
    const { fabs, issues } = fabMappingsFrom([row({ id: "1" }), row({ id: "2", childValue: "KOR" }), row({ parentValue2: "Other Fab" })]);
    expect(fabs.map((f) => f.fabLocation)).toEqual(["Other Fab"]);
    expect(issues).toEqual(["UMC / Fab 12A has 2 active mappings and was ignored until only one remains."]);
  });

  it("the same fab name under two customers is two separate mappings", () => {
    const { fabs, issues } = fabMappingsFrom([row({ parentValue1: "A", parentValue2: "Shared", childValue: "KOR" }), row({ parentValue1: "B", parentValue2: "Shared", childValue: "US" })]);
    expect(issues).toEqual([]);
    expect(fabs).toHaveLength(2);
  });

  it("a customer with no mapping has an empty Fab Location list and the approved message, not a placeholder", () => {
    const reference = { customers: [], customerFabs: fabMappingsFrom([row()]).fabs, competitorProducts: [], processLocations: [], technologyNodes: [] };
    expect(fieldOptions("fabLocation", { ...blankForm(), customer: "Nobody" }, { lookups: [], reference, user: null })).toEqual([]);
    expect(cascadeFallbackHelp("fabLocation", { ...blankForm(), customer: "Nobody" }, reference)).toBe("No Fab Locations available for this customer.");
    expect(cascadeFallbackHelp("fabLocation", { ...blankForm(), customer: "UMC" }, reference)).toBeNull();
    expect(fieldOptions("fabLocation", { ...blankForm(), customer: "UMC" }, { lookups: [], reference, user: null })).toEqual(["Fab 12A"]);
  });
});
