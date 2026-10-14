import { parseCsv } from "@/lib/csv";
import type { ParsedSheet } from "@/lib/ci/import/types";

/**
 * Reads an import file in the browser into header + rows of text. Nothing
 * is validated or saved here — the server does all checks. Every cell is
 * kept as text (numbers unparsed) so amounts reach the server exactly as
 * written in the file.
 */

export const MAX_IMPORT_FILE_BYTES = 15 * 1024 * 1024;

export class ImportFileError extends Error {}

export type ImportFileKind = "csv" | "xlsx" | "xls";

export function fileKind(name: string): ImportFileKind | null {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "csv" || ext === "xlsx" || ext === "xls" ? ext : null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // Excel stores dates as numbers; read-excel-file returns UTC Dates.
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

export async function readImportFile(file: File): Promise<ParsedSheet> {
  const kind = fileKind(file.name);
  if (!kind) throw new ImportFileError("Unsupported file type. Choose a .xlsx or .csv file.");
  if (file.size === 0) throw new ImportFileError("The file is empty.");
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportFileError("The file is larger than 15 MB. Split it and import it in parts.");
  if (kind === "xls") {
    // Legacy binary .xls needs a parser this project doesn't include (see the Import notes).
    throw new ImportFileError("Legacy .xls files can't be read yet. Open the file in Excel and save it as .xlsx (or .csv), then try again.");
  }

  let table: string[][];
  let sheetName: string | undefined;
  try {
    if (kind === "csv") {
      const { headers, rows } = parseCsv(await file.text(), { keepEmptyRows: true });
      table = [headers, ...rows];
    } else {
      const { default: readXlsxFile } = await import("read-excel-file/browser");
      const sheets = await readXlsxFile(file, { parseNumber: (s: string) => s });
      const first = sheets[0];
      if (!first) throw new ImportFileError("The workbook has no sheets.");
      sheetName = first.sheet;
      table = first.data.map((row) => row.map(cellText));
    }
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    console.error("[CI] Import file could not be read:", error);
    throw new ImportFileError("The file could not be opened. Check it is a valid .xlsx or .csv file.");
  }

  // Drop trailing fully-empty rows; keep inner empty rows (they are reported as "empty, skipped").
  while (table.length && table[table.length - 1].every((c) => c === "")) table.pop();
  const [headers = [], ...rows] = table;
  if (headers.every((h) => h === "")) throw new ImportFileError("The first row must contain the column headings.");
  return { fileName: file.name, sheetName, headers, rows };
}

/** One worksheet of an uploaded workbook: every cell as trimmed text, blank trailing rows dropped. */
export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

/**
 * Reads every sheet of an .xlsx workbook in the browser (the Lookups and
 * Sequential Dropdown imports use several sheets in one file). Nothing is
 * validated or saved here.
 */
export async function readWorkbook(file: File): Promise<WorkbookSheet[]> {
  if (fileKind(file.name) !== "xlsx") throw new ImportFileError("Unsupported file type. Choose an Excel (.xlsx) file.");
  if (file.size === 0) throw new ImportFileError("The file is empty.");
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportFileError("The file is larger than 15 MB. Split it and import it in parts.");
  try {
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const sheets = await readXlsxFile(file, { parseNumber: (s: string) => s });
    return sheets.map((sheet) => {
      const rows = sheet.data.map((row) => row.map(cellText));
      while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
      return { name: sheet.sheet, rows };
    });
  } catch (error) {
    console.error("[CI] Workbook could not be read:", error);
    throw new ImportFileError("The file could not be opened. Check it is a valid .xlsx file.");
  }
}

/** The sheet with this name (case-insensitive), if the workbook has one. */
export function findSheet(sheets: WorkbookSheet[], name: string): WorkbookSheet | undefined {
  return sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
