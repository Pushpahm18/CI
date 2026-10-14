"use client";

import * as React from "react";
import { CheckCircle2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { downloadIssues, FileChooser, PasteArea, VBox } from "@/components/ci/import/import-parts";
import { ApiError, ciApi } from "@/lib/ci/api";
import { parseCsv } from "@/lib/csv";
import { fileKind, readImportFile } from "@/lib/ci/import/file-reader";
import { BULK_CHANGE_NOTE_COLUMN } from "@/lib/ci/import/bulk";
import { cn } from "@/lib/utils";
import type { BulkPreview, ParsedSheet } from "@/lib/ci/import/types";

const ACCEPT = ".csv,.xlsx,.xls";

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
 * CI Prototype "Bulk update (CSV)": paste CSV (or choose a file) with the
 * grid's column headings, Validate, then import. Rows update the existing CI
 * row with the same Record ID (BRD §7.5 bulk update), are checked with the
 * same rules as a manual Edit, need a Change Note, and nothing is saved
 * while any row has a problem.
 */
export function BulkUpdatePanel({ onUpdated }: { onUpdated?: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [fileSheet, setFileSheet] = React.useState<ParsedSheet | null>(null);
  const [pasted, setPasted] = React.useState("");
  const [changeNote, setChangeNote] = React.useState("");
  const [preview, setPreview] = React.useState<BulkPreview | null>(null);
  const [validatedSheet, setValidatedSheet] = React.useState<ParsedSheet | null>(null);
  const [busy, setBusy] = React.useState<"" | "reading" | "validating" | "saving">("");
  const [confirming, setConfirming] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);

  const xlsxChosen = file !== null && fileKind(file.name) !== "csv";

  async function choose(f: File) {
    setFile(f);
    setPreview(null);
    setMessage(null);
    setBusy("reading");
    try {
      setFileSheet(await readImportFile(f));
      // CI Prototype: a chosen CSV file is shown in the paste box.
      setPasted(fileKind(f.name) === "csv" ? await f.text() : "");
    } catch (e) {
      setFileSheet(null);
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  function clearAll() {
    setFile(null);
    setFileSheet(null);
    setPasted("");
    setPreview(null);
    setValidatedSheet(null);
  }

  function currentSheet(): ParsedSheet | null {
    if (xlsxChosen) return fileSheet;
    if (!pasted.trim()) return null;
    const { headers, rows } = parseCsv(pasted, { keepEmptyRows: true });
    return { fileName: file?.name ?? "Pasted data", headers, rows };
  }

  async function validate() {
    const sheet = currentSheet();
    if (!sheet || sheet.rows.length === 0) {
      setPreview(null);
      setMessage({ tone: "danger", content: "Paste or choose some CSV rows, then press Validate." });
      return;
    }
    setBusy("validating");
    setMessage(null);
    try {
      setPreview(await ciApi.previewBulk(sheet, changeNote));
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
      const result = await ciApi.commitBulk(validatedSheet, changeNote);
      setMessage({
        tone: "success",
        content: (
          <>
            <b>{result.updated}</b> rows updated{result.skipped ? `, ${result.skipped} skipped (empty or unchanged)` : ""}.
            {!result.notification.delivered && " Summary email not sent — email delivery is not configured yet."}
          </>
        ),
      });
      clearAll();
      setChangeNote("");
      onUpdated?.();
    } catch (e) {
      setMessage(failure(e));
    } finally {
      setBusy("");
      setConfirming(false);
    }
  }

  const s = preview?.summary;
  const problemRows = preview?.rows.filter((r) => r.status === "error") ?? [];
  const updates = preview?.rows.filter((r) => r.status === "update") ?? [];
  const noteMissing = !changeNote.trim();

  return (
    <Card className="p-4">
      <div className="grid gap-3">
        <p className="text-[12.5px] text-muted">
          Paste CSV with the column headings used in the grid (including Record ID), or choose a file. Each row updates the CI row with that
          Record ID. Files that do not match the template are rejected with a message. Revenue and Fab Region are calculated; an optional “
          {BULK_CHANGE_NOTE_COLUMN}” column gives a row its own note.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <FileChooser file={file} accept={ACCEPT} disabled={busy !== ""} onChoose={(f) => void choose(f)} onRemove={clearAll} />
        </div>

        <PasteArea
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            setFile(null);
            setFileSheet(null);
            setPreview(null);
          }}
          disabled={busy === "saving" || xlsxChosen}
          placeholder={xlsxChosen ? `Reading from ${file?.name}` : "Record ID,Quarter,Year,Customer,…"}
          aria-label="Bulk CSV"
        />

        <div className={cn("max-w-2xl", noteMissing && "-m-1.5 rounded-md border-2 border-danger bg-danger-bg/50 p-1.5")}>
          <Label className="mb-1 block" htmlFor="bulk-change-note">
            Change Note <span className="text-danger">*</span>
          </Label>
          <Textarea
            id="bulk-change-note"
            rows={2}
            value={changeNote}
            onChange={(e) => {
              setChangeNote(e.target.value);
              setPreview(null);
            }}
            placeholder="Why are these rows being updated? (required)"
          />
        </div>

        {busy === "reading" && <p className="text-[13px] text-muted">Reading file…</p>}
        {message && <VBox tone={message.tone}>{message.content}</VBox>}

        {preview && s && (
          <>
            {preview.missingColumns.length > 0 && (
              <VBox tone="danger">
                File doesn&apos;t match the template — missing column(s): {preview.missingColumns.join(", ")}.
              </VBox>
            )}
            <VBox tone={s.invalid || preview.missingColumns.length ? "danger" : "success"}>
              <b>{s.validUpdates}</b> row{s.validUpdates === 1 ? "" : "s"} ready, <b>{s.invalid}</b> with problems.
              {s.notFound > 0 && ` ${s.notFound} Record ID${s.notFound === 1 ? "" : "s"} not found.`}
              {s.noChange + s.emptySkipped > 0 && ` ${s.noChange + s.emptySkipped} skipped (empty or unchanged).`}
              {preview.issues.length > 0 && (
                <Button size="sm" variant="ghost" className="ml-2 h-6 px-1.5" onClick={() => downloadIssues(preview.issues, preview.fileName)}>
                  <Download className="h-3.5 w-3.5" /> Download report
                </Button>
              )}
            </VBox>
            {problemRows.map((r) => (
              <VBox key={r.line} tone="danger">
                <b>Line {r.line}</b>
                {r.issues
                  .filter((i) => i.severity === "error")
                  .map((i, n) => (
                    <div key={n}>{i.message}</div>
                  ))}
              </VBox>
            ))}
            {updates.length > 0 && (
              <details className="rounded-[10px] bg-surface-alt px-3 py-2.5 text-[13px] text-foreground">
                <summary className="cursor-pointer text-spark-teal">Show the {updates.length} update{updates.length === 1 ? "" : "s"}</summary>
                {updates.map((r) => (
                  <div key={r.line} className="mt-2">
                    <b>{r.recordId}</b> (line {r.line})
                    {r.changes.map((c) => (
                      <div key={c.field} className="pl-3">
                        {c.label}: <span className="text-danger line-through">{c.previous || "(empty)"}</span> →{" "}
                        <span className="font-semibold text-success">{c.current || "(empty)"}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </>
        )}

        <div className="flex justify-end gap-2.5">
          <Button variant="outline" onClick={() => void validate()} disabled={busy !== "" || (!pasted.trim() && !fileSheet)}>
            {busy === "validating" ? "Validating…" : "Validate"}
          </Button>
          <Button disabled={!preview?.canCommit || busy !== ""} onClick={() => setConfirming(true)}>
            Import valid rows
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !o && busy !== "saving" && setConfirming(false)}>
        <DialogContent>
          <DialogHeader title="Confirm bulk update" onClose={busy === "saving" ? undefined : () => setConfirming(false)} />
          <DialogBody className="space-y-2 text-[13px] text-foreground">
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>
                Update <b>{s?.validUpdates}</b> existing row{s?.validUpdates === 1 ? "" : "s"} from <b>{preview?.fileName}</b>.
              </span>
            </p>
            <p className="text-muted">Each updated row gets the Change Note and an audit entry with the changed fields.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy === "saving"}>
              Cancel
            </Button>
            <Button onClick={() => void commit()} disabled={busy === "saving"}>
              {busy === "saving" ? "Updating…" : "Confirm and update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
