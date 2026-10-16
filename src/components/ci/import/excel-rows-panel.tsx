"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FileChooser, VBox } from "@/components/ci/import/import-parts";
import { ApiError, ciApi } from "@/lib/ci/api";
import { EXCEL_ID_LABEL, EXCEL_ROWS_TEMPLATE_HEADERS } from "@/lib/ci/import/add-rows";
import { fileKind, readImportFile } from "@/lib/ci/import/file-reader";
import { USER_FIELDS } from "@/lib/ci/field-spec";
import { downloadXlsx } from "@/lib/xlsx";
import type { ExcelRowsPreview, ParsedSheet } from "@/lib/ci/import/types";

type Message = { tone: "danger" | "success" | "warning"; content: React.ReactNode };

function failure(e: unknown): Message {
  const details = e instanceof ApiError ? e.details : [];
  return {
    tone: "danger",
    content: (
      <>
        <b>{e instanceof Error ? e.message : "Something went wrong. Please try again."}</b>
        {details.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </>
    ),
  };
}

const show = (v: string) => (v === "" ? "empty" : v);

/**
 * CI Prototype Import: add many rows, or change existing ones, from one Excel file. Download the template (the grid's
 * column headings) or "Download existing rows", fill / edit it, choose it, Validate, then Import valid rows. A line with
 * no Application ID adds a new row; a line with an existing row's Application ID updates that row. Every row is checked
 * with the same rules as manual entry on the server; rows with problems are listed and left out; Fab Region and Revenue
 * are calculated; Created By and Date default to you and today for new rows.
 */
export function ExcelRowsPanel({ onImported }: { onImported?: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [sheet, setSheet] = React.useState<ParsedSheet | null>(null);
  const [preview, setPreview] = React.useState<ExcelRowsPreview | null>(null);
  const [validatedSheet, setValidatedSheet] = React.useState<ParsedSheet | null>(null);
  const [busy, setBusy] = React.useState<"" | "reading" | "validating" | "saving" | "exporting">("");
  const [message, setMessage] = React.useState<Message | null>(null);

  async function downloadTemplate() {
    // Headings only: no sample rows are ever put in the template.
    await downloadXlsx("CI_Import_Template.xlsx", [{ name: "Rows", rows: [EXCEL_ROWS_TEMPLATE_HEADERS] }]);
  }

  async function downloadExisting() {
    setBusy("exporting");
    setMessage(null);
    try {
      const res = await ciApi.existingRowsForImport();
      const rows = res.records.map((r) => [
        r.applicationId ?? "",
        ...USER_FIELDS.map((f) => {
          const v = r[f.key];
          return f.numeric && v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : String(v ?? "");
        }),
      ]);
      await downloadXlsx("CI_Existing_Rows.xlsx", [{ name: "Rows", rows: [EXCEL_ROWS_TEMPLATE_HEADERS, ...rows] }]);
      if (res.truncated) {
        setMessage({ tone: "warning", content: `Only the newest ${res.rowLimit} rows were downloaded; the table holds more.` });
      }
    } catch (e) {
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  async function choose(f: File) {
    setFile(f);
    setPreview(null);
    setMessage(null);
    setSheet(null);
    if (fileKind(f.name) !== "xlsx") {
      setMessage({ tone: "danger", content: "This file could not be read. Use an .xlsx file; the template is a good starting point." });
      return;
    }
    setBusy("reading");
    try {
      setSheet(await readImportFile(f));
    } catch (e) {
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  function clearAll() {
    setFile(null);
    setSheet(null);
    setPreview(null);
    setValidatedSheet(null);
  }

  async function validate() {
    if (!sheet) return;
    if (sheet.rows.length === 0) {
      setPreview(null);
      setMessage({ tone: "danger", content: "The file has no rows under the headings." });
      return;
    }
    setBusy("validating");
    setMessage(null);
    try {
      setPreview(await ciApi.previewExcelRows(sheet));
      setValidatedSheet(sheet);
    } catch (e) {
      setPreview(null);
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  async function commit() {
    if (!validatedSheet || !preview?.canCommit) return;
    setBusy("saving");
    try {
      const result = await ciApi.commitExcelRows(validatedSheet);
      setMessage({
        tone: "success",
        content: (
          <>
            <b>{result.inserted}</b> added, <b>{result.updated}</b> updated.
            {!result.notification.delivered && " Summary email not sent — email delivery is not configured yet."}
          </>
        ),
      });
      clearAll();
      onImported?.();
    } catch (e) {
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  const s = preview?.summary;
  const problemRows = preview?.rows.filter((r) => r.status === "error") ?? [];
  const updateRows = preview?.rows.filter((r) => r.status === "update") ?? [];

  return (
    <Card className="min-h-[calc(100vh-140px)] p-4">
      <div className="grid gap-3">
        <p className="text-[12.5px] text-muted">
          Upload an Excel file (.xlsx) with the column headings used in the grid. To add rows, leave {EXCEL_ID_LABEL} blank. To change existing rows, put the
          row’s {EXCEL_ID_LABEL} in the first column: use “Download existing rows”, edit the values and import it again. Every row is checked against the same
          rules as manual entry; rows with problems are listed and not imported. Fab Region and Revenue are calculated; Created By and Date default to you and
          today for new rows.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void downloadTemplate()}>
            <Download className="h-4 w-4" /> Download template
          </Button>
          <Button variant="outline" onClick={() => void downloadExisting()} disabled={busy !== ""}>
            <Download className="h-4 w-4" /> {busy === "exporting" ? "Preparing…" : "Download existing rows"}
          </Button>
          <FileChooser label="Choose Excel file" file={file} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy !== ""} onChoose={(f) => void choose(f)} onRemove={clearAll} />
          {!file && <span className="text-[12.5px] text-muted">No file chosen</span>}
        </div>

        {busy === "reading" && <p className="text-[13px] text-muted">Reading file…</p>}
        {message && <VBox tone={message.tone}>{message.content}</VBox>}

        {preview && s && (
          <>
            {preview.missingColumns.length > 0 && <VBox tone="danger">These columns are missing: {preview.missingColumns.join(", ")}.</VBox>}
            <VBox tone={s.invalid || preview.missingColumns.length ? "danger" : "success"}>
              <b>{s.added}</b> new, <b>{s.updated}</b> to update
              {s.unchanged > 0 && (
                <>
                  , <b>{s.unchanged}</b> unchanged
                </>
              )}
              , <b>{s.invalid}</b> with problems.
              {s.emptySkipped > 0 && ` ${s.emptySkipped} empty row${s.emptySkipped === 1 ? "" : "s"} skipped.`}
            </VBox>
            {updateRows.slice(0, 5).map((r) => (
              <VBox key={r.line}>
                <b>{r.applicationId}</b> will change: {r.changes.map((c) => `${c.label} (${show(c.previous)} → ${show(c.current)})`).join("; ")}
              </VBox>
            ))}
            {updateRows.length > 5 && <p className="text-[12.5px] text-muted">…and {updateRows.length - 5} more updates.</p>}
            {problemRows.slice(0, 30).map((r) => (
              <VBox key={r.line} tone="danger">
                <b>Row {r.line}</b>
                {r.issues.map((i, n) => (
                  <div key={n}>{i.message}</div>
                ))}
              </VBox>
            ))}
            {problemRows.length > 30 && <p className="text-[12.5px] text-muted">…and {problemRows.length - 30} more rows with problems.</p>}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="outline" onClick={() => void validate()} disabled={!sheet || busy !== ""}>
            {busy === "validating" ? "Validating…" : "Validate"}
          </Button>
          <Button disabled={!preview?.canCommit || busy !== ""} onClick={() => void commit()}>
            {busy === "saving" ? "Importing…" : "Import valid rows"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
