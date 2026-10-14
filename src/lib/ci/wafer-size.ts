/**
 * Wafer Size: approved mapping between the dropdown label and the number
 * stored in ci_main.wafer_size_mm (a DOUBLE column holding 150 / 200 / 300).
 * Used for display and form selection only; stored data and the schema are not
 * changed. A value outside this mapping is never converted: the label lookup
 * returns null so the caller shows it exactly as stored and can report it.
 */

export const WAFER_SIZE_COLUMN = "wafer_size_mm";

export const WAFER_SIZE_LABELS: Readonly<Record<number, string>> = {
  300: '300mm (12")',
  200: '200mm (8")',
  150: '150mm (6")',
};

/** The label for a stored value (300, "300.0", ...), or null when blank or outside the approved mapping. */
export function waferLabelFor(stored: unknown): string | null {
  const text = String(stored ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? (WAFER_SIZE_LABELS[n] ?? null) : null;
}

/** The number to store for an exact dropdown label, or null when the label is not one of the three approved. */
export function waferStoredFor(label: unknown): number | null {
  const text = String(label ?? "").trim();
  const hit = Object.entries(WAFER_SIZE_LABELS).find(([, l]) => l === text);
  return hit ? Number(hit[0]) : null;
}

/**
 * The number to store for the Wafer Size a person picked on the Add / Edit form: an exact approved label, or the same three sizes
 * written more simply (300, 300mm, "300 mm", 300mm (12")). Any other size (100, 450, ...) is null and is refused, never converted.
 */
export function waferStoredForInput(text: unknown): number | null {
  const exact = waferStoredFor(text);
  if (exact !== null) return exact;
  const m = String(text ?? "").trim().match(/^(\d{3})(?:\.0+)?\s*(?:mm)?(?:\s*\(.*\))?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return WAFER_SIZE_LABELS[n] !== undefined ? n : null;
}

/** What a grid cell shows: the label when the value is one of the approved three, otherwise the value exactly as stored. */
export function waferDisplay(stored: string): string {
  return waferLabelFor(stored) ?? stored;
}

/** Non-blank stored values that are outside the approved mapping (reported, never converted). */
export function unexpectedWaferValues(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter((v) => v.trim() !== "" && waferLabelFor(v) === null)));
}
