import JSZip from "jszip";

/**
 * Writes real .xlsx workbooks in the browser (CI Prototype: every export and
 * every import template is an Excel file, not CSV). Same layout as the
 * prototype: one header row in the brand colour, frozen, auto-sized columns,
 * text stored as inline strings and numbers kept as numbers.
 *
 * Reading an uploaded workbook is done by lib/ci/import/file-reader.ts
 * (read-excel-file); this file only writes.
 */

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  /** Worksheet tab name (Excel limit: 31 characters, no []:*?/\). */
  name: string;
  /** First row is the heading row unless `noHeader`. */
  rows: XlsxCell[][];
  noHeader?: boolean;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const escapeXml = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c as "<" | ">" | "&" | '"'] as string);

/** 0 → A, 25 → Z, 26 → AA … */
function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const sheetName = (name: string, index: number) => String(name || `Sheet${index + 1}`).replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || `Sheet${index + 1}`;

export async function buildXlsx(sheets: XlsxSheet[]): Promise<Blob> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      "</Types>"
  );
  zip.file(
    "_rels/.rels",
    XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${escapeXml(sheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>"
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`
  );
  // Style 0 = body text, style 1 = heading row (white bold on the CI plum).
  zip.file(
    "xl/styles.xml",
    XML_HEAD +
      `<styleSheet xmlns="${NS_MAIN}">` +
      '<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5F4664"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  );

  sheets.forEach((sheet, index) => {
    const rows = sheet.rows;
    const width = Math.max(1, ...rows.map((r) => r.length));
    const widths: number[] = [];
    for (let c = 0; c < width; c++) {
      let longest = 8;
      for (const r of rows.slice(0, 300)) {
        const len = String(r[c] == null ? "" : r[c]).length;
        if (len > longest) longest = len;
      }
      widths.push(Math.min(46, longest + 2));
    }
    const body = rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            if (value === "" || value == null) return "";
            const ref = columnName(c) + (r + 1);
            const style = r === 0 && !sheet.noHeader ? ' s="1"' : "";
            return typeof value === "number" && Number.isFinite(value)
              ? `<c r="${ref}"${style}><v>${value}</v></c>`
              : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    zip.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      XML_HEAD +
        `<worksheet xmlns="${NS_MAIN}"><sheetViews><sheetView workbookViewId="0">` +
        (sheet.noHeader ? "" : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>') +
        "</sheetView></sheetViews><cols>" +
        widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") +
        `</cols><sheetData>${body}</sheetData></worksheet>`
    );
  });

  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** Builds the workbook and downloads it. The filename should end in .xlsx. */
export async function downloadXlsx(filename: string, sheets: XlsxSheet[]): Promise<void> {
  const blob = await buildXlsx(sheets);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Object rows → heading row + value rows; numbers stay numbers. Headings come from the first row's keys. */
export function sheetFromObjects(name: string, objects: Record<string, unknown>[], headings?: string[]): XlsxSheet {
  const heads = headings ?? (objects[0] ? Object.keys(objects[0]) : []);
  return {
    name,
    rows: [
      heads,
      ...objects.map((o) =>
        heads.map((h) => {
          const v = o[h];
          return typeof v === "number" || typeof v === "string" ? v : v == null ? "" : String(v);
        })
      ),
    ],
  };
}
