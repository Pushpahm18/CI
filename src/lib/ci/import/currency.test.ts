import { describe, expect, it } from "vitest";
import { convertRevenue, FxRateUnavailableError, toMillions } from "@/lib/ci/import/currency";

describe("revenue unit conversion (full amount → millions, currency kept)", () => {
  it("EUR 2,500,000 → 2.5 EUR (BRD rule)", () => {
    expect(convertRevenue(2_500_000, "EUR")).toEqual({ millions: 2.5, currency: "EUR" });
  });
  it("EUR 750,000 → 0.75 EUR", () => {
    expect(convertRevenue(750_000, "EUR")).toEqual({ millions: 0.75, currency: "EUR" });
  });
  it("USD 5,000,000 → 5 USD (no FX to EUR)", () => {
    expect(convertRevenue(5_000_000, "USD")).toEqual({ millions: 5, currency: "USD" });
  });
  it("USD 850,000 → 0.85 USD", () => {
    expect(convertRevenue(850_000, "USD")).toEqual({ millions: 0.85, currency: "USD" });
  });
  it("GBP 3,000,000 → 3 GBP", () => {
    expect(convertRevenue(3_000_000, "GBP")).toEqual({ millions: 3, currency: "GBP" });
  });
  it("JPY 800,000,000 → 800 JPY and KRW 2,500,000,000 → 2500 KRW", () => {
    expect(convertRevenue(800_000_000, "JPY")).toEqual({ millions: 800, currency: "JPY" });
    expect(convertRevenue(2_500_000_000, "KRW")).toEqual({ millions: 2500, currency: "KRW" });
  });
  it("toMillions is a pure unit change", () => {
    expect(toMillions(1_000_000)).toBe(1);
  });
});

describe("FX conversion is never applied without approved rates", () => {
  it("refuses an FX rule that has no rates", () => {
    expect(() => convertRevenue(5_000_000, "USD", { kind: "fx", targetCurrency: "EUR", rates: null })).toThrow(FxRateUnavailableError);
  });
  it("refuses a currency missing from the rate table", () => {
    expect(() => convertRevenue(1_000_000, "GBP", { kind: "fx", targetCurrency: "EUR", rates: { USD: 0.9 } })).toThrow(FxRateUnavailableError);
  });
  it("same source and target currency is only a unit change", () => {
    expect(convertRevenue(2_000_000, "EUR", { kind: "fx", targetCurrency: "EUR", rates: null })).toEqual({ millions: 2, currency: "EUR" });
  });
  it("uses a supplied (approved) rate when one is configured", () => {
    expect(convertRevenue(2_000_000, "USD", { kind: "fx", targetCurrency: "EUR", rates: { USD: 0.5 } })).toEqual({ millions: 1, currency: "EUR" });
  });
});
