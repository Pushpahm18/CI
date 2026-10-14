/**
 * Revenue / ASP amount handling for imports.
 *
 * Two different things are kept deliberately separate:
 *  1. UNIT conversion — full amounts → millions (CI stores ASP and Revenue
 *     "in millions of the row's Currency", BRD §7.2 / §8). The currency is
 *     unchanged: EUR 2,500,000 → 2.5 EUR; USD 5,000,000 → 5 USD.
 *  2. FX conversion — one currency into another. NOT approved for CI: there
 *     is no business-approved exchange-rate source, so it is never applied
 *     implicitly. The `fx` rule exists only so an approved rate table can be
 *     plugged in later; without rates it refuses to convert.
 */

export const ONE_MILLION = 1_000_000;

export type ConversionRule =
  | { kind: "unit-only" }
  | { kind: "fx"; targetCurrency: string; rates: Readonly<Record<string, number>> | null };

export const DEFAULT_CONVERSION_RULE: ConversionRule = { kind: "unit-only" };

export class FxRateUnavailableError extends Error {}

export interface ConvertedAmount {
  /** Amount in millions. */
  millions: number;
  currency: string;
}

/** Full amount → millions, currency unchanged (unit conversion only). */
export function toMillions(amount: number): number {
  return amount / ONE_MILLION;
}

/** Rounds to a fixed number of decimals (used only where the CI Prototype defines the precision). */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Converts a full source amount into CI's "millions of currency" form.
 * With the default unit-only rule the currency is preserved. An FX rule
 * must carry approved rates; otherwise this throws rather than guessing.
 */
export function convertRevenue(
  sourceAmount: number,
  sourceCurrency: string,
  rule: ConversionRule = DEFAULT_CONVERSION_RULE
): ConvertedAmount {
  if (!Number.isFinite(sourceAmount)) throw new RangeError("Amount must be a finite number.");
  if (rule.kind === "unit-only" || rule.targetCurrency === sourceCurrency) {
    return { millions: toMillions(sourceAmount), currency: sourceCurrency };
  }
  const rate = rule.rates?.[sourceCurrency];
  if (rate === undefined) {
    throw new FxRateUnavailableError(
      `No approved exchange rate from ${sourceCurrency} to ${rule.targetCurrency}; FX conversion is not configured.`
    );
  }
  return { millions: toMillions(sourceAmount * rate), currency: rule.targetCurrency };
}
