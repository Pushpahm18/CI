/** Small, pure value helpers shared by the import pipelines. */

/** Normalised comparison key (CI Prototype): trim, collapse spaces, tidy " - ", case-insensitive. */
export function normaliseValue(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .toLowerCase();
}

/** Finds the CI list value a file value refers to, ignoring spacing/case differences. */
export function matchListValue(value: string, options: readonly string[]): string | undefined {
  const key = normaliseValue(value);
  if (!key) return undefined;
  return options.find((o) => o === value) ?? options.find((o) => normaliseValue(o) === key);
}

export type ParsedNumber = { ok: true; value: number } | { ok: false };

/** Parses a number written with optional thousands separators, spaces or a currency symbol. */
export function parseAmount(raw: string): ParsedNumber {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[\s,€$£¥₩]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false };
  const value = Number(cleaned);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

/** ISO calendar date (yyyy-mm-dd) check; Excel dates are converted to this form when the file is read. */
export function parseIsoDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

export function isBlankRow(row: readonly string[]): boolean {
  return row.every((c) => String(c ?? "").trim() === "");
}

/** Column lookup by header, case- and whitespace-insensitive. */
export function headerIndex(headers: readonly string[]): (label: string) => number {
  const map = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = normaliseValue(h);
    if (!map.has(key)) map.set(key, i);
  });
  return (label) => map.get(normaliseValue(label)) ?? -1;
}

export function missingHeaders(headers: readonly string[], required: readonly string[]): string[] {
  const idx = headerIndex(headers);
  return required.filter((h) => idx(h) < 0);
}

export function unexpectedHeaders(headers: readonly string[], known: readonly string[]): string[] {
  const knownKeys = new Set(known.map(normaliseValue));
  return headers.filter((h) => h.trim() !== "" && !knownKeys.has(normaliseValue(h)));
}
