"use client";

import * as React from "react";
import { CheckCircle2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { downloadIssues, FileChooser, VBox } from "@/components/ci/import/import-parts";
import { ApiError, ciApi } from "@/lib/ci/api";
import { EXCEL_ROWS_TEMPLATE_HEADERS } from "@/lib/ci/import/add-rows";
import { fileKind, readImportFile } from "@/lib/ci/import/file-reader";
import { downloadXlsx } from "@/lib/xlsx";
import type { ExcelRowsPreview, ParsedSheet } from "@/lib/ci/import/types";

type Message = { tone: "danger" | "success"; content: React.ReactNode };

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

/**
 * CI Prototype Import: add many rows at once from an Excel file. Download the
 * template (the grid's column headings, no sample rows), fill it in, choose it,
 * Validate, then Import valid rows. Every row is checked with the same rules as
 * manual entry on the server; rows with problems are listed and left out; Fab
 * Region and Revenue are calculated; Created By and Date default to you and
 * today.
 */
export function ExcelRowsPanel({ onImported }: { onImported?: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [sheet, setSheet] = React.useState<ParsedSheet | null>(null);
  const [preview, setPreview] = React.useState<ExcelRowsPreview | null>(null);
  const [validatedSheet, setValidatedSheet] = React.useState<ParsedSheet | null>(null);
  const [busy, setBusy] = React.useState<"" | "reading" | "validating" | "saving">("");
  const [confirming, setConfirming] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);

  async function downloadTemplate() {
    // Headings only: no sample rows are ever put in the template.
    await downloadXlsx("CI_Import_Template.xlsx", [{ name: "Rows", rows: [EXCEL_ROWS_TEMPLATE_HEADERS] }]);
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
            <b>{result.inserted}</b> row{result.inserted === 1 ? "" : "s"} imported
            {result.skipped ? `, ${result.skipped} skipped (empty or with problems)` : ""}.
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
      setConfirming(false);
    }
  }

  const s = preview?.summary;
  const problemRows = preview?.rows.filter((r) => r.status === "error") ?? [];

  return (
    <Card className="min-h-[calc(100vh-140px)] p-4">
      <div className="grid gap-3">
        <p className="text-[12.5px] text-muted">
          Upload an Excel file (.xlsx) with the column headings used in the grid. Every row is checked against the same rules as manual entry; rows
          with problems are listed and not imported. Fab Region and Revenue are calculated; Created By and Date default to you and today.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void downloadTemplate()}>
            <Download className="h-4 w-4" /> Download template
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
              <b>{s.ready}</b> row{s.ready === 1 ? "" : "s"} ready, <b>{s.invalid}</b> with problems.
              {s.emptySkipped > 0 && ` ${s.emptySkipped} empty row${s.emptySkipped === 1 ? "" : "s"} skipped.`}
              {preview.issues.length > 0 && (
                <Button size="sm" variant="ghost" className="ml-2 h-6 px-1.5" onClick={() => downloadIssues(preview.issues, preview.fileName)}>
                  <Download className="h-3.5 w-3.5" /> Download report
                </Button>
              )}
            </VBox>
            {problemRows.slice(0, 30).map((r) => (
              <VBox key={r.line} tone="danger">
                <b>Row {r.line}</b>
                {r.issues.map((i, n) => (
                  <div key={n}>{i.message}</div>
                ))}
              </VBox>
            ))}
            {problemRows.length > 30 && <p className="text-[12.5px] text-muted">…and {problemRows.length - 30} more rows with problems (see the report).</p>}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Button variant="outline" onClick={() => void validate()} disabled={!sheet || busy !== ""}>
            {busy === "validating" ? "Validating…" : "Validate"}
          </Button>
          <Button disabled={!preview?.canCommit || busy !== ""} onClick={() => setConfirming(true)}>
            Import valid rows
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !o && busy !== "saving" && setConfirming(false)}>
        <DialogContent>
          <DialogHeader title="Confirm import" onClose={busy === "saving" ? undefined : () => setConfirming(false)} />
          <DialogBody className="space-y-2 text-[13px] text-foreground">
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>
                Add <b>{s?.ready}</b> new row{s?.ready === 1 ? "" : "s"} from <b>{preview?.fileName}</b>.
                {s && s.invalid > 0 ? ` ${s.invalid} row${s.invalid === 1 ? "" : "s"} with problems will be left out.` : ""}
              </span>
            </p>
            <p className="text-muted">Each added row gets an audit entry and a first Change Note.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy === "saving"}>
              Cancel
            </Button>
            <Button onClick={() => void commit()} disabled={busy === "saving"}>
              {busy === "saving" ? "Importing…" : "Confirm and import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
