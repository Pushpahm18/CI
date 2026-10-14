"use client";

import * as React from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ExcelImportResult {
  /** How many items were applied. */
  ok: number;
  /** One line per skipped row / problem. */
  skip: string[];
  /** Past-tense verb for the summary ("added", "repositioned"). */
  verb?: string;
}

/**
 * The CI Prototype's "import from Excel" dialog (Lookups, Sequential Dropdown):
 * Download current file / Choose Excel file / Import, then "N added, M skipped"
 * with the first dozen skipped rows. The caller's `run` reads the workbook and
 * applies it; this component only handles the file choice and the report.
 */
export function ExcelImportDialog({
  open,
  title,
  help,
  onClose,
  onDownload,
  run,
}: {
  open: boolean;
  title: string;
  help: React.ReactNode;
  onClose: () => void;
  onDownload: () => Promise<void>;
  run: (file: File) => Promise<ExcelImportResult>;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ExcelImportResult | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  function close() {
    if (busy) return;
    setFile(null);
    setResult(null);
    onClose();
  }

  async function go() {
    if (!file) return;
    setBusy(true);
    try {
      setResult(await run(file));
    } catch (e) {
      setResult({ ok: 0, skip: [e instanceof Error ? e.message : "The file could not be read."] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader title={title} onClose={close} />
        <DialogBody className="space-y-3 text-[13px] text-foreground">
          <p className="text-muted">{help}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void onDownload()}>
              <Download className="h-4 w-4" /> Download current file
            </Button>
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
                e.target.value = "";
              }}
            />
            <Button variant="outline" onClick={() => input.current?.click()}>
              <Upload className="h-4 w-4" /> Choose Excel file
            </Button>
          </div>
          <p className="text-muted">{file ? file.name : "No file chosen"}</p>
          {result && (
            <div className="grid gap-1.5">
              <div className={cn("rounded-[10px] px-3 py-2.5", result.skip.length ? "bg-danger-bg" : "bg-success-bg")}>
                <b>{result.ok}</b> {result.verb ?? "added"}, <b>{result.skip.length}</b> skipped.
              </div>
              {result.skip.slice(0, 12).map((s, i) => (
                <div key={i} className="text-[12.5px] text-muted">
                  {s}
                </div>
              ))}
              {result.skip.length > 12 && <div className="text-[12.5px] text-muted">…and {result.skip.length - 12} more.</div>}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button onClick={() => void go()} disabled={!file || busy}>
            <Upload className="h-4 w-4" /> {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
