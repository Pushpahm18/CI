import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/ci/errors";
import { limitToScope, loadAvailableFormOptions, type FormOptionsDeps } from "@/server/ci/form-options/service";
import type { AccountScope } from "@/server/ci/authorization/scope";
import type { FormOptionsResponse } from "@/types/ci-api";
import type { LookupValue } from "@/types/ci";

// Fakes only: nothing here opens a Databricks connection.
const identity = { email: "pushpa@example.com", name: "Pushpa" } as never;

const lk = (id: string, category: string, value: string): LookupValue => ({ id, category, value, sortOrder: 1, active: true });
const LOOKUPS: LookupValue[] = [
  lk("1", "Customer", "Samsung"),
  lk("2", "Customer", "Micron"),
  lk("3", "Served Market", "Logic"),
  lk("4", "Served Market", "DRAM"),
  lk("5", "Fab Region", "KOR"),
  lk("6", "Fab Region", "USA"),
  lk("7", "Quarter", "Q1"),
];

const make = (authorize: FormOptionsDeps["authorize"]): FormOptionsDeps => ({
  requireTables: () => {},
  requireConnected: () => {},
  authorize,
  repository: () => ({ listLookups: async () => LOOKUPS }),
  dependentLists: async () => ({
    customerFabs: [
      { customer: "Samsung", fabLocation: "Samsung Austin", fabRegion: "USA" },
      { customer: "Samsung", fabLocation: "Samsung Hwaseong", fabRegion: "KOR" },
      { customer: "Micron", fabLocation: "Micron Boise", fabRegion: "USA" },
    ],
    competitorProducts: [{ competitor: "TEL", product: "Trias" }],
    processLocations: [
      { servedMarket: "Logic", processLocation: "Front End 1" },
      { servedMarket: "DRAM", processLocation: "Capacitor" },
    ],
    technologyNodes: [
      { customer: "Samsung", servedMarket: "Logic", technologyNode: "SF2" },
      { customer: "Samsung", servedMarket: "DRAM", technologyNode: "D1a" },
      { customer: "Micron", servedMarket: "DRAM", technologyNode: "1alpha" },
    ],
    entries: [],
    issues: [],
  }),
});

const scope = (over: Partial<AccountScope> = {}): AccountScope => ({ customers: ["Samsung"], segments: ["Logic"], regions: ["KOR"], ...over });

describe("form options for an Account Team user", () => {
  it("is allowed (it used to be refused as 'Corporate Marketing access is required') and sees only the dropdowns inside the scope", async () => {
    const res = await loadAvailableFormOptions(identity, make(async () => ({ role: "Account Team", scope: scope() })));
    expect(res.reference.customers).toEqual(["Samsung"]);
    expect(res.lookups.filter((l) => l.category === "Customer").map((l) => l.value)).toEqual(["Samsung"]);
    expect(res.lookups.filter((l) => l.category === "Served Market").map((l) => l.value)).toEqual(["Logic"]);
    expect(res.lookups.filter((l) => l.category === "Fab Region").map((l) => l.value)).toEqual(["KOR"]);
    expect(res.reference.customerFabs.map((f) => f.fabLocation)).toEqual(["Samsung Hwaseong"]);
    expect(res.reference.technologyNodes.map((n) => n.technologyNode)).toEqual(["SF2"]);
    expect(res.reference.processLocations.map((p) => p.processLocation)).toEqual(["Front End 1"]);
  });

  it("keeps the lists that are not part of the scope (Quarter, Top Competitor products)", async () => {
    const res = await loadAvailableFormOptions(identity, make(async () => ({ scope: scope() })));
    expect(res.lookups.some((l) => l.category === "Quarter")).toBe(true);
    expect(res.reference.competitorProducts).toHaveLength(1);
  });

  it("a dimension set to All keeps everything on that dimension", async () => {
    const res = await loadAvailableFormOptions(identity, make(async () => ({ scope: scope({ segments: "All", regions: "All" }) })));
    expect(res.reference.customerFabs.map((f) => f.fabLocation)).toEqual(["Samsung Austin", "Samsung Hwaseong"]);
    expect(res.reference.technologyNodes.map((n) => n.technologyNode)).toEqual(["SF2", "D1a"]);
  });

  it("Corporate Marketing (no scope) gets every option", async () => {
    const res = await loadAvailableFormOptions(identity, make(async () => ({ role: "Corporate Marketing", scope: null })));
    expect(res.reference.customers).toEqual(["Samsung", "Micron"]);
    expect(res.reference.customerFabs).toHaveLength(3);
    expect(res.lookups).toHaveLength(LOOKUPS.length);
  });

  it("someone with no CI access is still refused", async () => {
    const deps = make(async () => {
      throw new ForbiddenError("no");
    });
    await expect(loadAvailableFormOptions(identity, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("limitToScope does not change its input", () => {
    const input = { lookups: LOOKUPS, reference: { customers: ["Samsung", "Micron"], customerFabs: [], competitorProducts: [], processLocations: [], technologyNodes: [] }, pendingSources: [] } as FormOptionsResponse;
    limitToScope(input, scope());
    expect(input.reference.customers).toEqual(["Samsung", "Micron"]);
    expect(input.lookups).toHaveLength(LOOKUPS.length);
  });
});
