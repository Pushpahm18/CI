import { describe, expect, it } from "vitest";
import {
  MAX_SCOPE_VALUES,
  accountScopeFrom,
  parseScopeArray,
  parseScopeDimension,
  rowInAccountScope,
  scopeIsUnrestricted,
  serializeScope,
  serializeScopeDimension,
} from "@/server/ci/authorization/scope";

describe("parseScopeArray (strict, fail closed)", () => {
  it("accepts a clean JSON array of distinct text values, including commas and quotes inside names", () => {
    expect(parseScopeArray('["TSMC","UMC"]')).toEqual({ ok: true, values: ["TSMC", "UMC"] });
    expect(parseScopeArray('["Foo, Inc.","Say \\"hi\\""]')).toEqual({ ok: true, values: ["Foo, Inc.", 'Say "hi"'] });
  });

  it("rejects missing, malformed, empty and ambiguous values", () => {
    const bad: (string | null | undefined)[] = [
      null, undefined, "", "   ", "All", "TSMC,UMC", "[oops", "{}", '"TSMC"', "42", "[]",
      "[1]", "[null]", '[""]', '["  "]', '[" TSMC"]', '["TSMC "]', '["TSMC","TSMC"]', '["All"]', '["x","ALL"]', '["All","TSMC"]', '[["a"]]',
    ];
    for (const text of bad) expect(parseScopeArray(text).ok, String(text)).toBe(false);
  });

  it("rejects oversized lists and values", () => {
    expect(parseScopeArray(JSON.stringify(Array.from({ length: MAX_SCOPE_VALUES + 1 }, (_, i) => `v${i}`))).ok).toBe(false);
    expect(parseScopeArray(JSON.stringify(["x".repeat(201)])).ok).toBe(false);
    expect(parseScopeArray(JSON.stringify(Array.from({ length: MAX_SCOPE_VALUES }, (_, i) => `v${i}`))).ok).toBe(true);
  });
});

describe("parseScopeDimension: All is a defined scope, a list is specific values, anything else is invalid", () => {
  it("reads exactly All, or a valid JSON array", () => {
    expect(parseScopeDimension("All")).toEqual({ ok: true, setting: "All" });
    expect(parseScopeDimension(" All ")).toEqual({ ok: true, setting: "All" });
    expect(parseScopeDimension('["UMC"]')).toEqual({ ok: true, setting: ["UMC"] });
  });

  it("All is never an ordinary value and never mixed with values", () => {
    for (const bad of ["all", "ALL", "Everything", "*", "", "UMC", "UMC,TSMC", '["All"]', '["All","UMC"]', "[]", "null"]) {
      expect(parseScopeDimension(bad).ok, bad).toBe(false);
    }
  });
});

describe("serialization", () => {
  it("trims and de-duplicates lists and round-trips through the strict reader", () => {
    const text = serializeScope([" TSMC", "UMC ", "TSMC"]);
    expect(text).toBe('["TSMC","UMC"]');
    expect(parseScopeDimension(text)).toEqual({ ok: true, setting: ["TSMC", "UMC"] });
    expect(serializeScopeDimension("All")).toBe("All");
  });
  it("refuses to serialize anything the reader would reject", () => {
    for (const v of [[], [""], ["All"], ["a", "ALL"]]) expect(() => serializeScopeDimension(v)).toThrow(/Invalid scope/);
  });
});

describe("accountScopeFrom and rowInAccountScope", () => {
  const rec = { customer: '["UMC","TSMC"]', segment: '["Foundry"]', region: '["TWN"]' };
  const row = { customer: "UMC", segment: "Foundry", region: "TWN" };

  it("needs all three dimensions to be valid (All or a list)", () => {
    expect(accountScopeFrom(rec).ok).toBe(true);
    expect(accountScopeFrom({ customer: "All", segment: "All", region: "All" }).ok).toBe(true);
    for (const key of ["customer", "segment", "region"] as const) {
      for (const bad of ["", "all", "a,b", "[oops", "[]", '["All"]', '["UMC","UMC"]']) {
        expect(accountScopeFrom({ ...rec, [key]: bad }).ok, `${key}:${bad}`).toBe(false);
      }
    }
  });

  it("a row is in scope only when Customer AND Served Market AND Region all match exactly; All covers any value", () => {
    const r = accountScopeFrom(rec);
    if (!r.ok) throw new Error("setup");
    expect(rowInAccountScope(r.scope, row)).toBe(true);
    expect(rowInAccountScope(r.scope, { ...row, customer: "Intel" })).toBe(false);
    expect(rowInAccountScope(r.scope, { ...row, segment: "Logic" })).toBe(false);
    expect(rowInAccountScope(r.scope, { ...row, region: "KOR" })).toBe(false);
    expect(rowInAccountScope(r.scope, { ...row, customer: "umc" })).toBe(false); // exact match, not case-folded
    expect(rowInAccountScope(r.scope, { customer: "", segment: "", region: "" })).toBe(false);
  });

  it("supports every All / specific combination", () => {
    const scope = (customer: string, segment: string, region: string) => {
      const r = accountScopeFrom({ customer, segment, region });
      if (!r.ok) throw new Error(r.reason);
      return r.scope;
    };
    const allAll = scope("All", "All", "All");
    expect(scopeIsUnrestricted(allAll)).toBe(true);
    expect(rowInAccountScope(allAll, { customer: "Anyone", segment: "Anything", region: "Anywhere" })).toBe(true);

    const oneCustomer = scope('["UMC"]', "All", "All");
    expect(scopeIsUnrestricted(oneCustomer)).toBe(false);
    expect(rowInAccountScope(oneCustomer, { customer: "UMC", segment: "Logic", region: "KOR" })).toBe(true);
    expect(rowInAccountScope(oneCustomer, { customer: "Intel", segment: "Logic", region: "KOR" })).toBe(false);

    const customerAndMarket = scope('["UMC"]', '["Foundry"]', "All");
    expect(rowInAccountScope(customerAndMarket, { customer: "UMC", segment: "Foundry", region: "JPN" })).toBe(true);
    expect(rowInAccountScope(customerAndMarket, { customer: "UMC", segment: "Logic", region: "JPN" })).toBe(false);

    const specific = scope('["UMC"]', '["Foundry"]', '["TWN"]');
    expect(rowInAccountScope(specific, row)).toBe(true);
    expect(rowInAccountScope(specific, { ...row, region: "JPN" })).toBe(false);

    const allMarketsOneRegion = scope("All", "All", '["TWN"]');
    expect(rowInAccountScope(allMarketsOneRegion, { customer: "X", segment: "Y", region: "TWN" })).toBe(true);
    expect(rowInAccountScope(allMarketsOneRegion, { customer: "X", segment: "Y", region: "KOR" })).toBe(false);
  });
});
