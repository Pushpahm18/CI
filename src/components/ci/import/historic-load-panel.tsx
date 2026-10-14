"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { PaginationFooter, usePagination } from "@/components/ui/pagination";
import {
  FileChooser,
  IssuesReport,
  PasteArea,
  Pill,
  SectionTitle,
  Stat,
  StatRow,
  VBox,
  type PillTone,
} from "@/components/ci/import/import-parts";
import { ApiError, ciApi } from "@/lib/ci/api";
import { parseCsv } from "@/lib/csv";
import { fileKind, readImportFile } from "@/lib/ci/import/file-reader";
import { mappingKey } from "@/lib/ci/import/historic";
import { HISTORIC_COLUMNS } from "@/lib/ci/import/historic-config";
import type { HistoricOptions, HistoricPreview, HistoricRowStatus, ParsedSheet, ValueMapping } from "@/lib/ci/import/types";

const ACCEPT = ".xlsx,.xls,.csv";
const PASTE_DEBOUNCE_MS = 500;

// CI Prototype row-review result pills.
const RESULT_PILL: Record<HistoricRowStatus, { label: string; tone: PillTone }> = {
  ready: { label: "Ready", tone: "ok" },
  flagged: { label: "Flagged", tone: "warn" },
  held: { label: "Held", tone: "danger" },
  empty: { label: "Empty, skipped", tone: "off" },
  "not-loaded": { label: "Not loaded", tone: "off" },
};

// CI Prototype value-mapping status pills.
const MAPPING_PILL: Record<ValueMapping["status"], { label: string; tone: PillTone }> = {
  exact: { label: "Exact", tone: "ok" },
  suggested: { label: "Suggested, confirm", tone: "warn" },
  mapped: { label: "Mapped", tone: "role" },
  cleaned: { label: "Cleaned", tone: "role" },
  unmapped: { label: "Needs mapping", tone: "danger" },
};

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

const twoDp = (n: number | undefined) => (n === undefined ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/**
 * CI Prototype "Historic load (regional files)". The file (or pasted CSV)
 * is validated, mapped to the CI lists and transformed on the server; the
 * user reviews the value mapping and every row, then confirms the load into
 * the CI main table. Nothing loads while any row is held.
 */
export function HistoricLoadPanel({ onLoaded }: { onLoaded?: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [pasted, setPasted] = React.useState("");
  const [sheet, setSheet] = React.useState<ParsedSheet | null>(null);
  const [options, setOptions] = React.useState<HistoricOptions>({ loadNotCompetitor: true, mappingOverrides: {} });
  const [preview, setPreview] = React.useState<HistoricPreview | null>(null);
  const [busy, setBusy] = React.useState<"" | "reading" | "validating" | "saving">("");
  const [confirming, setConfirming] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const pasteTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(pasteTimer.current), []);

  async function validate(nextSheet: ParsedSheet, nextOptions: HistoricOptions) {
    setBusy("validating");
    try {
      setPreview(await ciApi.previewHistoric(nextSheet, nextOptions));
    } catch (e) {
      setPreview(null);
      setMessage(failure(e));
    } finally {
      setBusy("");
    }
  }

  function freshOptions() {
    const next = { ...options, mappingOverrides: {} };
    setOptions(next);
    return next;
  }

  async function choose(f: File) {
    clearTimeout(pasteTimer.current);
    setFile(f);
    setPreview(null);
    setMessage(null);
    const next = freshOptions();
    setBusy("reading");
    try {
      const parsed = await readImportFile(f);
      // CI Prototype: a chosen CSV file is shown in the paste box.
      setPasted(fileKind(f.name) === "csv" ? await f.text() : "");
      setSheet(parsed);
      await validate(parsed, next);
    } catch (e) {
      setSheet(null);
      setBusy("");
      setMessage(failure(e));
    }
  }

  function onPaste(text: string) {
    setPasted(text);
    setFile(null);
    setPreview(null);
    setMessage(null);
    clearTimeout(pasteTimer.current);
    if (!text.trim()) {
      setSheet(null);
      return;
    }
    pasteTimer.current = setTimeout(() => {
      const { headers, rows } = parseCsv(text, { keepEmptyRows: true });
      if (rows.length === 0) return;
      const parsed: ParsedSheet = { fileName: "Pasted data", headers, rows };
      setSheet(parsed);
      void validate(parsed, freshOptions());
    }, PASTE_DEBOUNCE_MS);
  }

  function clearAll() {
    clearTimeout(pasteTimer.current);
    setFile(null);
    setPasted("");
    setSheet(null);
    setPreview(null);
  }

  function updateOptions(next: HistoricOptions) {
    setOptions(next);
    if (sheet) void validate(sheet, next);
  }

  async function commit() {
    if (!sheet || !preview?.canCommit) return;
    setBusy("saving");
    try {
      const result = await ciApi.commitHistoric(sheet, options);
      setMessage({
        tone: "success",
        content: (
          <>
            <b>{result.inserted}</b> historic rows loaded into the CI table. Open All Competitive Info View to see them (Currency EUR, blank Order
            Type).
            {!result.notification.delivered && " Summary email not sent — email delivery is not configured yet."}
          </>
        ),
      });
      clearAll();
      onLoaded?.();
    } catch (e) {
      setMessage(failure(e));
    } finally {
      setBusy("");
      setConfirming(false);
    }
  }

  const rows = React.useMemo(() => preview?.rows ?? [], [preview]);
  const { pageItems, page, pageCount, pageSize, total, setPage, setPageSize } = usePagination(rows, 25);
  const s = preview?.summary;
  const currency = Array.from(new Set(rows.map((r) => r.record?.currency).filter(Boolean)));
  const amountUnit = currency.length === 1 ? `M ${currency[0]}` : "M";

  return (
    <Card className="p-4">
      <div className="grid gap-3.5">
        <VBox tone="warning">
          <b>How the historic load works.</b> Regional files (for example Korea) and the 2020 file are consolidated into one table. Values are
          mapped to the CI lists; Euro amounts are converted to millions with Currency = EUR; the old Notes become the first Change Note; Fab
          Region comes from the fab master; Order Type stays blank; empty rows are skipped.
        </VBox>

        <div className="flex flex-wrap items-center gap-2">
          <FileChooser file={file} accept={ACCEPT} disabled={busy !== ""} onChoose={(f) => void choose(f)} onRemove={clearAll} />
          <label className="ml-1 inline-flex items-center gap-1.5 text-[12.5px] text-muted">
            <Checkbox
              checked={options.loadNotCompetitor}
              disabled={busy !== ""}
              onChange={(e) => updateOptions({ ...options, loadNotCompetitor: e.target.checked })}
            />
            Load rows noted “Not competitor…” (flagged, note kept as Change Note)
          </label>
        </div>

        <PasteArea
          value={pasted}
          onChange={(e) => onPaste(e.target.value)}
          disabled={busy === "saving" || (file !== null && fileKind(file.name) !== "csv")}
          placeholder={file && fileKind(file.name) !== "csv" ? `Reading from ${file.name}` : HISTORIC_COLUMNS.join(",")}
          aria-label="Regional file CSV"
        />

        {busy === "reading" && <p className="text-[13px] text-muted">Reading file…</p>}
        {busy === "validating" && <p className="text-[13px] text-muted">Validating and mapping rows…</p>}
        {message && <VBox tone={message.tone}>{message.content}</VBox>}

        {preview && s && (
          <>
            {preview.missingColumns.length > 0 && (
              <VBox tone="danger">Columns not found in the file: {preview.missingColumns.join(", ")}.</VBox>
            )}
            {preview.unexpectedColumns.length > 0 && (
              <VBox tone="warning">Columns not used: {preview.unexpectedColumns.join(", ")}.</VBox>
            )}

            <StatRow>
              <Stat value={s.totalRows} label="Rows read" />
              <Stat value={s.emptySkipped} label="Empty rows skipped" />
              <Stat value={s.inserts} label={`Ready to load${s.flagged ? ` (${s.flagged} flagged)` : ""}`} />
              <Stat value={s.held} label="Held: needs mapping" tone={s.held ? "danger" : undefined} />
            </StatRow>

            {preview.mappings.length > 0 && (
              <div>
                <SectionTitle>Value mapping (source value → CI list value)</SectionTitle>
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Field</TH>
                        <TH>Value in file</TH>
                        <TH>Maps to (CI list)</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {preview.mappings.map((m) => (
                        <TR key={mappingKey(m.field, m.source)}>
                          <TD className="text-left">{m.label}</TD>
                          <TD className="text-left">
                            <code className="font-mono text-[11.5px]">{JSON.stringify(m.source)}</code>
                          </TD>
                          <TD className="text-left">
                            <select
                              value={m.target}
                              disabled={busy !== ""}
                              aria-label={`Map ${m.source}`}
                              onChange={(e) =>
                                updateOptions({
                                  ...options,
                                  mappingOverrides: { ...options.mappingOverrides, [mappingKey(m.field, m.source)]: e.target.value },
                                })
                              }
                              className="h-7 min-w-[200px] rounded-md border border-border-strong bg-surface px-1.5 text-[12.5px] text-foreground"
                            >
                              <option value="">Select CI value…</option>
                              {m.options.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          </TD>
                          <TD className="text-left">
                            <Pill tone={MAPPING_PILL[m.status].tone}>{MAPPING_PILL[m.status].label}</Pill>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </div>
            )}

            <div>
              <SectionTitle>Row review</SectionTitle>
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Line</TH>
                      <TH>Result</TH>
                      <TH>Quarter</TH>
                      <TH>Customer</TH>
                      <TH>Fab</TH>
                      <TH>Fab Region</TH>
                      <TH>Served Market</TH>
                      <TH>Competitor</TH>
                      <TH className="text-right">ASP ({amountUnit})</TH>
                      <TH className="text-right">Revenue ({amountUnit})</TH>
                      <TH>Created By (file)</TH>
                      <TH>Note → Change Note</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {pageItems.map((r) => {
                      const empty = r.status === "empty";
                      const rec = r.record;
                      const src = r.source;
                      return (
                        <TR key={r.line} className={empty ? "opacity-50" : undefined}>
                          <TD className="text-left tabular-nums">{r.line}</TD>
                          <TD className="text-left">
                            <Pill tone={RESULT_PILL[r.status].tone}>{RESULT_PILL[r.status].label}</Pill>
                          </TD>
                          <TD className="text-left">{empty ? "" : `${src.Quarter} ${src.Year}`}</TD>
                          <TD className="text-left">{empty ? "" : rec?.customer || src.Customer}</TD>
                          <TD className="text-left">{src["Fab Location"]}</TD>
                          <TD className="text-left">{empty ? "" : rec?.fabRegion || "— (fab not in master)"}</TD>
                          <TD className="text-left">{empty ? "" : rec?.servedMarket || src["Served Market"]}</TD>
                          <TD className="text-left">{empty ? "" : rec?.topCompetitor || src["Top Competitor"]}</TD>
                          <TD className="text-right tabular-nums">{empty ? "" : twoDp(rec?.asp)}</TD>
                          <TD className="text-right tabular-nums">{empty ? "" : twoDp(rec?.revenue)}</TD>
                          <TD className="text-left">{src["Created By"]}</TD>
                          <TD className="min-w-[180px] whitespace-normal text-left">{src.Notes}</TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </TableWrap>
              {total > 25 && (
                <PaginationFooter page={page} pageCount={pageCount} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
              )}
            </div>

            <IssuesReport issues={preview.issues} fileName={preview.fileName} />

            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[12.5px] text-muted">
                Fabs not in the master load with Fab Region blank; they are listed in the review above for the data owner to complete.
              </span>
              <span className="flex-1" />
              <Button disabled={!preview.canCommit || busy !== ""} onClick={() => setConfirming(true)}>
                Load {s.inserts} rows
              </Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !o && busy !== "saving" && setConfirming(false)}>
        <DialogContent>
          <DialogHeader title="Confirm historic load" onClose={busy === "saving" ? undefined : () => setConfirming(false)} />
          <DialogBody className="space-y-2 text-[13px] text-foreground">
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>
                Load <b>{s?.inserts}</b> rows from <b>{preview?.fileName}</b> into the CI table
                {s?.flagged ? `, including ${s.flagged} flagged “Not competitor” row${s.flagged === 1 ? "" : "s"}` : ""}.
              </span>
            </p>
            <p className="text-muted">Each row gets its old note as the first Change Note and an “Imported” audit entry.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy === "saving"}>
              Cancel
            </Button>
            <Button onClick={() => void commit()} disabled={busy === "saving"}>
              {busy === "saving" ? "Loading…" : "Confirm and load"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
