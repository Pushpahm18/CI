// Why the UTF-8 BOM (a tester issue on an earlier export: "text format
// is different... only in ASM env"): this generation is pure client-side JS (Blob built in
// the browser, byte-identical for a given code version regardless of which
// environment served it), so a same-code-version diff isn't a feasible
// explanation — but several real export columns carry a literal non-ASCII
// placeholder character ("—", U+2014 — buClassification/applicationSegment/
// opsTool/opsProductGroup/project1/subModuleProcessGroup all default to this
// when unmapped, see delta-store.ts's createApplication()) as actual DATA,
// not just UI/comment text. Without a UTF-8 byte-order-mark, Excel's CSV
// importer guesses the file's encoding from the system's default ANSI/OEM
// codepage instead of trusting the `charset=utf-8` MIME hint — a
// well-documented Excel behavior — and a Windows machine whose default
// codepage differs from wherever this was first verified (plausible for a
// different client network/region) would render those bytes as garbled
// text, while the exact same file opens correctly elsewhere. Prepending the
// BOM makes Excel detect UTF-8 reliably regardless of the opening machine's
// locale — this changes nothing about columns, values, delimiters, or
// number/date formatting, only how the encoding is declared.
const UTF8_BOM = "﻿";

export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    const blob = new Blob([UTF8_BOM], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename);
    return;
  }
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  const blob = new Blob([UTF8_BOM + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseCsv(
  text: string,
  options: { keepEmptyRows?: boolean } = {}
): { headers: string[]; rows: string[][] } {
  // Strips a leading BOM (see downloadCsv()'s own doc comment) so a file
  // this app exported and a user re-imports unmodified still has its first
  // header match exactly (e.g. "Row ID", not "﻿Row ID") — FileReader
  // generally already strips it, but not guaranteed across every browser.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Quote-aware (RFC 4180 style): downloadCsv() above quotes any value that
  // contains a comma, quote or newline — CI values like `300mm (12")` do —
  // so a plain split(",") would break a file this app itself exported.
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (quoted) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && stripped[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      records.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  records.push(row);
  // keepEmptyRows: a row of only separators (",,,") is kept so imports can
  // count it as an empty row; a truly blank line is always dropped.
  const lines = records
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c.length > 0) || (options.keepEmptyRows === true && r.length > 1));
  if (lines.length === 0) return { headers: [], rows: [] };
  return { headers: lines[0], rows: lines.slice(1) };
}
