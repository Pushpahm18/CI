"use client";

import * as React from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchToolbar } from "@/components/ui/search-toolbar";
import { usePagination } from "@/components/ui/pagination";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiData } from "@/hooks/use-ci-data";
import { ApiError, ciApi } from "@/lib/ci/api";
import { ExcelImportDialog, type ExcelImportResult } from "@/components/ci/excel-import-dialog";
import { findSheet, readWorkbook } from "@/lib/ci/import/file-reader";
import { downloadXlsx } from "@/lib/xlsx";
import { cn } from "@/lib/utils";

/*
 * Sequential Dropdown — modelled on the CI Prototype: a tab per dropdown, a
 * search box, a table you reorder by dragging a row or typing its new number,
 * 50 rows per page, and Download / Import as Excel.
 *
 * Reordering (and Excel import of an order) is saved for the lists that live in
 * Lookups (Served Market, Top Competitor) through the existing reorder API.
 * Product Name, Process Location and Technology Node are ci_lookup_dependent rows
 * (GET /api/dependent-lists). Their display_order is kept per parent (Top Competitor,
 * Served Market, Customer + Served Market), so a row moves only within its own parent and
 * its Order number is its position there. Customer, Served Market and Top Competitor are
 * ci_lookup lists ordered as a whole.
 * PENDING-CI-TABLE: no sample data is ever shown.
 */

interface Item {
  /** ci_lookup / ci_lookup_dependent row id; undefined where nothing can be saved (Customer). */
  id?: string;
  cells: string[];
  /** Dependent lists only: the parent group the order is kept in. */
  group?: { key: string; list: string; parent1: string; parent2: string };
}

type TabId = "customer" | "market" | "comp" | "pname" | "ploc" | "node";

const TABS: { id: TabId; label: string; cols: string[]; lookupCategory?: string; dependent?: "comp" | "proc" | "node"; source: "lookups" | "reference" }[] = [
  { id: "customer", label: "Customer", cols: ["Customer"], lookupCategory: "Customer", source: "lookups" },
  { id: "market", label: "Served Market", cols: ["Served Market"], lookupCategory: "Served Market", source: "lookups" },
  { id: "comp", label: "Top Competitor", cols: ["Top Competitor"], lookupCategory: "Top Competitor", source: "lookups" },
  { id: "pname", label: "Product Name", cols: ["Top Competitor", "Product Name"], dependent: "comp", source: "reference" },
  { id: "ploc", label: "Process Location", cols: ["Served Market", "Process Location"], dependent: "proc", source: "reference" },
  { id: "node", label: "Technology Node", cols: ["Customer", "Served Market", "Technology Node"], dependent: "node", source: "reference" },
];

export function SequenceScreen() {
  const lookups = useCiData(() => ciApi.listLookups());
  const ref = useCiData(() => ciApi.dependentLists());
  const [tabId, setTabId] = React.useState<TabId>("customer");
  const [search, setSearch] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);
  const [dragFrom, setDragFrom] = React.useState<number | null>(null);
  const [dropOn, setDropOn] = React.useState<number | null>(null);
  const [orderDraft, setOrderDraft] = React.useState<Record<number, string>>({});
  const [importing, setImporting] = React.useState(false);

  const tab = TABS.find((t) => t.id === tabId)!;
  const source = tab.source === "lookups" ? lookups : ref;

  const items: Item[] = React.useMemo(() => {
    if (tab.source === "lookups") {
      return (lookups.data?.lookups ?? [])
        .filter((l) => l.active && l.category === tab.lookupCategory)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => ({ id: l.id, cells: [l.value] }));
    }
    if (!tab.dependent || !ref.data) return [];
    const dep = tab.dependent;
    return ref.data.entries
      .filter((e) => e.list === dep)
      .map((e) => {
        const key = e.parent2 ? `${e.parent1} · ${e.parent2}` : e.parent1;
        return { e, key };
      })
      .sort((x, y) => x.key.localeCompare(y.key) || x.e.sortOrder - y.e.sortOrder)
      .map(({ e, key }) => ({
        id: e.id,
        cells: dep === "node" ? [e.parent1, e.parent2, e.value] : [e.parent1, e.value],
        group: { key, list: e.list, parent1: e.parent1, parent2: e.parent2 },
      }));
  }, [tab, lookups.data, ref.data]);

  const editable = (tab.source === "lookups" || tab.dependent !== undefined) && !busy;
  /** Items of the same parent group (the whole list for ci_lookup lists), in order. */
  const groupOf = (i: number) => (items[i].group ? items.filter((x) => x.group?.key === items[i].group!.key) : items);
  const posOf = (i: number) => groupOf(i).indexOf(items[i]) + 1;
  const indexed = React.useMemo(() => items.map((it, i) => ({ it, i })), [items]);
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? indexed.filter(({ it }) => it.cells.join(" ").toLowerCase().includes(q)) : indexed;
  }, [indexed, search]);
  const { pageItems, page, pageCount, pageSize, total, setPage } = usePagination(filtered, 50);

  async function save(group: Item["group"], orderedIds: string[]) {
    if (group) await ciApi.reorderDependent({ list: group.list, parent1: group.parent1, parent2: group.parent2, orderedIds });
    else await ciApi.reorderLookups({ category: tab.lookupCategory!, orderedIds });
  }

  /** Moves item `from` to position `to` (0-based, within its group). Dependent rows move only inside their own parent. */
  async function moveWithin(from: number, toIndexInGroup: number) {
    if (!editable) return;
    const list = groupOf(from);
    if (toIndexInGroup === list.indexOf(items[from]) || toIndexInGroup < 0 || toIndexInGroup >= list.length) return;
    const ids = list.map((it) => it.id!);
    const [moved] = ids.splice(list.indexOf(items[from]), 1);
    ids.splice(toIndexInGroup, 0, moved);
    setBusy(true);
    setMessage(null);
    try {
      await save(items[from].group, ids);
      setMessage({ kind: "ok", text: "Order saved. The dropdown now lists values in this sequence." });
      const position = new Map(ids.map((rowId, n) => [rowId, n + 1]));
      if (items[from].group) ref.mutate((d) => ({ ...d, entries: d.entries.map((e) => (position.has(e.id) ? { ...e, sortOrder: position.get(e.id)! } : e)) }));
      else lookups.mutate((d) => ({ ...d, lookups: d.lookups.map((l) => (position.has(l.id) ? { ...l, sortOrder: position.get(l.id)! } : l)) }));
      void (items[from].group ? ref.refresh() : lookups.refresh());
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  async function moveItem(from: number, to: number) {
    if (from === to || to < 0 || to >= items.length) return;
    if (items[from].group && items[from].group!.key !== items[to].group?.key) {
      setMessage({ kind: "warn", text: `A row can only be moved within its own ${tab.cols[0]}.` });
      return;
    }
    await moveWithin(from, groupOf(to).indexOf(items[to]));
  }

  async function download() {
    await downloadXlsx(`CI_Sequence_${tab.label.replace(/\s+/g, "_")}.xlsx`, [
      { name: tab.label, rows: [["Order", ...tab.cols], ...items.map((it, i) => [posOf(i), ...it.cells])] },
    ]);
  }

  /**
   * Import an order: rows are placed in the order given (the Order column, or file order);
   * values not in the file stay after them; values that are not already in the list are
   * skipped (add them under Lookups).
   */
  async function importOrder(file: File): Promise<ExcelImportResult> {
    const sheets = await readWorkbook(file);
    const sheet = findSheet(sheets, tab.label) ?? sheets[0];
    const rows = sheet ? sheet.rows : [];
    const hasOrder = rows.length > 0 && /^order$/i.test(rows[0][0] ?? "");
    const body = hasOrder ? rows.slice(1) : rows;
    const byKey = new Map(items.map((it) => [it.cells.join("|").toLowerCase(), it]));
    const skip: string[] = [];
    const placed: Item[] = [];
    const used = new Set<string>();
    body
      .map((r, i) => ({ r, i, ord: hasOrder && r[0] !== "" && !Number.isNaN(Number(r[0])) ? Number(r[0]) : i }))
      .sort((a, b) => a.ord - b.ord)
      .forEach(({ r, i }) => {
        const cells = (hasOrder ? r.slice(1, 1 + tab.cols.length) : r.slice(0, tab.cols.length)).map((c) => c.trim());
        const key = cells.join("|").toLowerCase();
        const line = i + 1 + (hasOrder ? 1 : 0);
        const item = byKey.get(key);
        if (!item) skip.push(`Row ${line}: “${cells.join(" / ")}” is not in the list`);
        else if (used.has(key)) skip.push(`“${cells.join(" / ")}” appears twice; first position used`);
        else {
          used.add(key);
          placed.push(item);
        }
      });
    if (placed.length > 0) {
      // Per group (the whole list for ci_lookup lists): placed rows first, in file order; the rest keep their order after them.
      const keys = Array.from(new Set(items.map((it) => it.group?.key ?? "")));
      for (const k of keys) {
        const inGroup = items.filter((it) => (it.group?.key ?? "") === k);
        const first = placed.filter((it) => (it.group?.key ?? "") === k);
        if (first.length === 0) continue;
        const next = [...first, ...inGroup.filter((it) => !first.includes(it))];
        if (next.every((it, n) => it === inGroup[n])) continue;
        await save(inGroup[0].group, next.map((it) => it.id!));
      }
      await Promise.all([lookups.refresh(), ref.refresh()]);
      setMessage({ kind: "ok", text: "Order saved. The dropdown now lists values in this sequence." });
    }
    return { ok: placed.length, skip, verb: "repositioned" };
  }

  return (
    <>
      <div className="mb-3 flex shrink-0 flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTabId(t.id);
              setSearch("");
              setMessage(null);
              setOrderDraft({});
            }}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              t.id === tabId
                ? "border-transparent bg-accent text-accent-foreground"
                : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {source.errorMessage && <StatusBanner message={{ kind: "bad", text: source.errorMessage }} />}

      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <SearchToolbar value={search} onChange={setSearch} onRefresh={() => void source.reload()} placeholder="Search through keywords" inputWidthClass="w-[260px] sm:w-[380px]" />
        <span className="text-[12.5px] text-muted">{items.length} values</span>
        <span className="flex-1" />
        <Button variant="outline" onClick={() => setImporting(true)} disabled={!editable || !items.length} >
          <Upload className="h-4 w-4" /> Import
        </Button>
        <Button onClick={() => void download()} disabled={!items.length}>
          <Download className="h-4 w-4" /> Download
        </Button>
      </div>

      <p className="mb-2 shrink-0 text-[12.5px] text-muted">
        Drag a row onto another row to put it in that position, or type a new number in its Order box and press Enter. Forms and filters then list values in this order instead of A–Z.
      </p>

      {source.notConfigured ? (
        <TableWrap>
          <NotConnectedState what={tab.label} pending={source.pendingTables} />
        </TableWrap>
      ) : source.loading ? (
        <TableWrap>
          <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
        </TableWrap>
      ) : (
        <Card className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-auto">
            <Table>
              <THead>
                <TR>
                  <TH className="w-9" />
                  <TH className="w-24">Order</TH>
                  {tab.cols.map((c) => (
                    <TH key={c}>{c}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {pageItems.map(({ it, i }) => (
                  <TR
                    key={`${i}-${it.cells.join("|")}`}
                    draggable={editable}
                    onDragStart={() => setDragFrom(i)}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDropOn(null);
                    }}
                    onDragOver={(e: React.DragEvent) => {
                      if (!editable) return;
                      e.preventDefault();
                      setDropOn(i);
                    }}
                    onDrop={(e: React.DragEvent) => {
                      e.preventDefault();
                      if (dragFrom != null) void moveItem(dragFrom, i);
                      setDragFrom(null);
                      setDropOn(null);
                    }}
                    className={cn(dragFrom === i && "opacity-40", dropOn === i && dragFrom !== i && "shadow-[inset_0_2px_0_var(--accent)]")}
                  >
                    <TD className={cn("select-none text-center text-muted", editable ? "cursor-grab" : "opacity-40")} aria-hidden="true" title={editable ? "Drag to reorder" : undefined}>
                      ⋮⋮
                    </TD>
                    <TD>
                      <input
                        type="number"
                        min={1}
                        max={groupOf(i).length}
                        disabled={!editable}
                        aria-label={`Order of ${it.cells.join(" ")}`}
                        value={orderDraft[i] ?? String(posOf(i))}
                        onChange={(e) => setOrderDraft({ ...orderDraft, [i]: e.target.value })}
                        onBlur={() =>
                          setOrderDraft((d) => {
                            const n = { ...d };
                            delete n[i];
                            return n;
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const n = Math.round(Number(e.currentTarget.value));
                          if (n >= 1 && n <= groupOf(i).length) void moveWithin(i, n - 1);
                          else setMessage({ kind: "warn", text: `Enter a number from 1 to ${groupOf(i).length}.` });
                          e.currentTarget.blur();
                        }}
                        className="h-7 w-[72px] rounded-md border border-border-strong bg-surface px-2 text-[12.5px] disabled:opacity-60"
                      />
                    </TD>
                    {it.cells.map((c, k) => (
                      <TD key={k}>{c}</TD>
                    ))}
                  </TR>
                ))}
                {pageItems.length === 0 && (
                  <TR>
                    <TD colSpan={tab.cols.length + 2} className="py-10 text-center text-muted">
                      {items.length ? "No values match." : "No values yet."}
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </div>
        </Card>
      )}
      <ExcelImportDialog
        open={importing}
        title={`Import order: ${tab.label}`}
        help={`Excel columns: Order, ${tab.cols.join(", ")}. Rows are placed in the order given; values not in the file stay after them. Values not already in the list are skipped (add them under Lookups).`}
        onClose={() => setImporting(false)}
        onDownload={download}
        run={importOrder}
      />
      {!source.loading && !source.notConfigured && (
        <div className="flex shrink-0 items-center gap-3 px-1 pt-3 text-[12.5px] text-muted">
          <span>{total ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}` : "No values"}</span>
          <span className="flex-1" />
          <div className="flex gap-1">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page" className="h-[30px] min-w-[30px] rounded-md border border-border bg-surface text-foreground disabled:opacity-40">
              ‹
            </button>
            <button type="button" className="h-[30px] min-w-[30px] rounded-md border border-accent bg-accent font-semibold text-accent-foreground">
              {page}
            </button>
            <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page" className="h-[30px] min-w-[30px] rounded-md border border-border bg-surface text-foreground disabled:opacity-40">
              ›
            </button>
          </div>
        </div>
      )}
    </>
  );
}
