"use client";

import * as React from "react";
import { Download, Pencil, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { ExcelImportDialog, type ExcelImportResult } from "@/components/ci/excel-import-dialog";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiData } from "@/hooks/use-ci-data";
import { ApiError, ciApi } from "@/lib/ci/api";
import { LOOKUP_CATEGORIES } from "@/lib/ci/field-spec";
import { findSheet, readWorkbook } from "@/lib/ci/import/file-reader";
import { downloadXlsx, type XlsxSheet } from "@/lib/xlsx";
import { cn } from "@/lib/utils";
import type { DependentAddRequest, DependentEntryDto } from "@/types/ci-api";

/*
 * Lookups — the layout of the approved prototype (Draft_Version1):
 *
 *   top bar    "Import from Excel" and "Export to Excel" (one pair, all lists)
 *   left       one card with two groups: "Dropdown lists" and "Dependent lists", each
 *              with its value count
 *   right      the list's name and "N values"; numbered values, each with "used by N rows",
 *              an edit (rename) pencil and a remove x; an add row; a footer note.
 *              A dependent list also has its parent selector ("Filter customers" for
 *              fabs, "New <parent>") and, for fabs, the Fab Region as a pill.
 *
 * Data: dropdown values are ci_lookup; the four dependent lists are ci_lookup_dependent
 * (GET/POST/PATCH/DELETE /api/dependent-lists). Remove only sets a value inactive.
 * Remove asks for confirmation (the prototype's "Delete value?" dialog).
 */

const DROPDOWN_SHEET = "Dropdown Lists";
const REMOVE_NOTE = "Removing a value keeps it on existing rows; it just stops appearing in new dropdowns.";
// Process Location is left out of the Dropdown lists (as in the prototype): its values sit under a Served Market in the dependent lists.
// Customer and Top Competitor are independent lists here too; the dependent lists take their parents from them.
const DROPDOWN_CATEGORIES: string[] = LOOKUP_CATEGORIES.filter((c) => c !== "Process Location");

type DependentId = DependentEntryDto["list"];

interface Dependent {
  id: DependentId;
  name: string;
  parent: string;
  child: string;
  sheet: string;
  headers: string[];
  note: string;
  /** The ci_lookup list the parent value must belong to, if any. */
  parentLookup?: string;
}

const DEPENDENTS: Dependent[] = [
  {
    id: "comp",
    name: "Top Competitor → Product Name",
    parent: "Top Competitor",
    child: "Product Name",
    sheet: "Product Names",
    headers: ["Top Competitor", "Product Name"],
    note: "Choosing a Top Competitor in the form limits the Product Name dropdown to the products listed here.",
    parentLookup: "Top Competitor",
  },
  {
    id: "proc",
    name: "Served Market → Process Location",
    parent: "Served Market",
    child: "Process Location",
    sheet: "Process Locations",
    headers: ["Served Market", "Process Location"],
    note: "Choosing a Served Market limits the Process Location dropdown to these values.",
    parentLookup: "Served Market",
  },
  {
    id: "fab",
    name: "Customer → Fab Location",
    parent: "Customer",
    child: "Fab Location",
    sheet: "Fab Locations",
    headers: ["Customer", "Fab Location", "Fab Region"],
    note: "Fab Region is filled from the fab chosen here. Account Team users see only fabs inside their Region scope.",
    parentLookup: "Customer",
  },
  {
    id: "node",
    name: "Customer + Served Market → Technology Node",
    parent: "Customer · Served Market",
    child: "Technology Node",
    sheet: "Technology Nodes",
    headers: ["Customer", "Served Market", "Technology Node"],
    note: "The node list depends on both Customer and Served Market.",
  },
];

interface Group {
  key: string;
  parent1: string;
  parent2: string;
  items: DependentEntryDto[];
}

const keyOf = (parent1: string, parent2: string) => (parent2 ? `${parent1} · ${parent2}` : parent1);

function sheetRow(e: DependentEntryDto): string[] {
  if (e.list === "fab") return [e.parent1, e.value, e.region ?? ""];
  if (e.list === "node") return [e.parent1, e.parent2, e.value];
  return [e.parent1, e.value];
}

function ListButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-[11px] text-left text-[13.5px] font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent-bg"
      )}
    >
      <span>{label}</span>
      {count !== null && <span className="text-[12px] opacity-70">{count}</span>}
    </button>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <h6 className="mx-2 mb-0.5 mt-2.5 text-[10.5px] font-bold uppercase tracking-[0.9px] text-muted first:mt-1">{children}</h6>;
}

function PanelHeader({ title, count }: { title: string; count: string }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 bg-table-header-solid-bg px-5 py-3.5 text-table-header-solid-fg">
      <h2 className="text-[18px] font-bold">{title}</h2>
      <span className="text-[12px] opacity-80">{count}</span>
    </div>
  );
}

/** One numbered value: the pencil turns it into an input (and, for fabs, a Fab Region select) with Save / Cancel, as in the prototype. */
function ValueRow({
  n,
  value,
  pill,
  sub,
  regions,
  busy,
  onRename,
  onRemove,
}: {
  n: number;
  value: string;
  pill?: string;
  sub?: string;
  regions?: string[];
  busy: boolean;
  onRename: (value: string, region?: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(value);
  const [region, setRegion] = React.useState(pill ?? "");
  const save = () => {
    setEditing(false);
    onRename(text.trim(), regions ? region : undefined);
  };
  return (
    <div className="flex min-h-[52px] items-center gap-2 border-b border-border px-5 py-2.5 text-[13.5px] even:bg-surface-alt">
      <span className="w-7 tabular-nums text-[12px] text-muted">{n}</span>
      {editing ? (
        <>
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="New name"
          />
          {regions && (
            <select value={region} onChange={(e) => setRegion(e.target.value)} className="h-9 max-w-[170px] rounded-md border border-border-strong bg-surface px-2 text-[13px]" aria-label="Fab Region">
              {(pill && !regions.includes(pill) ? [pill, ...regions] : regions).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          )}
          <Button size="sm" onClick={save} disabled={busy || !text.trim()}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 break-words text-foreground">
            {value}
            {pill && <span className="ml-2 rounded-full bg-accent-bg px-2 py-0.5 text-[11.5px] font-semibold text-accent">{pill}</span>}
          </span>
          {sub && <span className="whitespace-nowrap text-[12px] text-muted">{sub}</span>}
          <Button
            size="icon"
            variant="ghost"
            title={regions ? "Edit name or region" : "Rename"}
            aria-label={`Edit ${value}`}
            disabled={busy}
            onClick={() => {
              setText(value);
              setRegion(pill ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" title="Remove" aria-label={`Remove ${value}`} disabled={busy} onClick={onRemove} className="hover:bg-danger-bg hover:text-danger">
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

export function LookupsScreen() {
  const lookupData = useCiData(() => ciApi.listLookups());
  const dependent = useCiData(() => ciApi.dependentLists());
  const [selected, setSelected] = React.useState<string>(`l:${DROPDOWN_CATEGORIES[0]}`);
  const [newValue, setNewValue] = React.useState("");
  const [newRegion, setNewRegion] = React.useState("");
  const [parentChoice, setParentChoice] = React.useState<Record<string, string>>({});
  const [nodeChoice, setNodeChoice] = React.useState({ customer: "", market: "" });
  const [customerFilter, setCustomerFilter] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);
  const [confirm, setConfirm] = React.useState<{ label: string; run: () => void } | null>(null);
  const [newParent, setNewParent] = React.useState<{ name: string; market: string; err: string } | null>(null);
  const [importing, setImporting] = React.useState(false);

  const all = React.useMemo(() => (lookupData.data?.lookups ?? []).filter((l) => l.active), [lookupData.data]);
  const usage = lookupData.data?.usage ?? {};
  const countFor = (c: string) => all.filter((l) => l.category === c).length;
  const listValues = (c: string) => all.filter((l) => l.category === c).sort((a, b) => a.sortOrder - b.sortOrder);

  const dep = DEPENDENTS.find((x) => `d:${x.id}` === selected) ?? null;
  const category = dep ? "" : selected.slice(2);
  const hasUsage = (lookupData.data?.usageCategories ?? []).includes(category);
  const values = listValues(category);
  const entries = React.useMemo(() => dependent.data?.entries ?? [], [dependent.data]);
  const totalOf = (id: DependentId) => entries.filter((e) => e.list === id).length;
  const regions = Array.from(new Set([...entries.filter((e) => e.list === "fab").map((e) => e.region ?? ""), ...listValues("Fab Region").map((l) => l.value)].filter(Boolean))).sort();
  const markets = listValues("Served Market").map((l) => l.value);

  /** The selected list's groups: every parent that has values, the parents of the matching dropdown list (comp, proc) and parents just created here. */
  const groups: Group[] = React.useMemo(() => {
    if (!dep) return [];
    const m = new Map<string, Group>();
    const touch = (parent1: string, parent2: string) => {
      const key = keyOf(parent1, parent2);
      if (!m.has(key)) m.set(key, { key, parent1, parent2, items: [] });
      return m.get(key)!;
    };
    if (dep.parentLookup) for (const l of all.filter((x) => x.category === dep.parentLookup)) touch(l.value, "");
    for (const e of entries.filter((x) => x.list === dep.id)) touch(e.parent1, e.parent2).items.push(e);
    return Array.from(m.values())
      .map((g) => ({ ...g, items: g.items.sort((a, b) => a.sortOrder - b.sortOrder) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [dep, all, entries]);

  const shownGroups = dep?.id === "fab" && customerFilter.trim() ? groups.filter((g) => g.key.toLowerCase().includes(customerFilter.trim().toLowerCase())) : groups;
  // Technology Node is picked with two dropdowns (Customer, Served Market); the pair is the group, whether or not it has nodes yet.
  // The Customer dropdown is the Customer list (Dropdown lists > Customer).
  const nodeCustomers = Array.from(new Set(listValues("Customer").map((l) => l.value))).sort((a, b) => a.localeCompare(b));
  const nodeCustomer = nodeCustomers.includes(nodeChoice.customer) ? nodeChoice.customer : (nodeCustomers[0] ?? "");
  const nodeMarket = markets.includes(nodeChoice.market) ? nodeChoice.market : (markets[0] ?? "");
  const nodeGroup: Group | null =
    dep?.id === "node" && nodeCustomer && nodeMarket
      ? (groups.find((g) => g.parent1 === nodeCustomer && g.parent2 === nodeMarket) ?? { key: keyOf(nodeCustomer, nodeMarket), parent1: nodeCustomer, parent2: nodeMarket, items: [] })
      : null;
  const group = dep?.id === "node" ? nodeGroup : dep ? (shownGroups.find((g) => g.key === parentChoice[dep.id]) ?? shownGroups[0] ?? null) : null;

  /**
   * Runs one change. As soon as the server confirms it, `apply` updates the list on screen (no waiting, no "Loading…"),
   * and the fresh data is fetched quietly in the background to settle anything the server decided differently.
   */
  async function run<R>(action: () => Promise<R>, okText?: string, apply?: (result: R) => void, which: "lookups" | "dependent" = "lookups") {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      apply?.(result);
      if (okText) setMessage({ kind: "ok", text: okText });
      void (which === "lookups" ? lookupData.refresh() : dependent.refresh());
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  function addDropdown() {
    const v = newValue.trim();
    if (!v) return setMessage({ kind: "warn", text: "Enter a value." });
    if (values.some((l) => l.value.toLowerCase() === v.toLowerCase())) return setMessage({ kind: "warn", text: `“${v}” already exists in ${category}.` });
    void run(
      async () => {
        const created = await ciApi.addLookup({ category, value: v });
        setNewValue("");
        return created.lookup;
      },
      `“${v}” added to ${category}.`,
      (lookup) => lookupData.mutate((d) => ({ ...d, lookups: [...d.lookups, lookup] }))
    );
  }

  function addDependent() {
    if (!dep || !group) return;
    const v = newValue.trim();
    if (!v) return setMessage({ kind: "warn", text: "Enter a value." });
    if (group.items.some((e) => e.value.toLowerCase() === v.toLowerCase())) return setMessage({ kind: "warn", text: `“${v}” already exists under ${group.key}.` });
    if (dep.id === "fab" && !newRegion) return setMessage({ kind: "warn", text: "Choose the Fab Region." });
    const sortOrder = group.items.reduce((m, e) => Math.max(m, e.sortOrder), 0) + 1;
    const region = dep.id === "fab" ? newRegion : undefined;
    const { id: list, parent1, parent2 } = { id: dep.id, parent1: group.parent1, parent2: group.parent2 };
    void run(
      async () => {
        const created = await ciApi.addDependent({ list, parent1, parent2: parent2 || undefined, value: v, region });
        setNewValue("");
        return created.id;
      },
      `“${v}” added under ${group.key}.`,
      (id) => dependent.mutate((d) => ({ ...d, entries: [...d.entries, { id, list, parent1, parent2, value: v, region, sortOrder }] })),
      "dependent"
    );
  }

  function createParent() {
    if (!dep || !newParent) return;
    const name = newParent.name.trim();
    if (!name && dep.id !== "node") return setNewParent({ ...newParent, err: "Enter a name." });
    if (dep.id === "node") {
      if (!newParent.name) return setNewParent({ ...newParent, err: "Choose a Customer." });
      if (!newParent.market) return setNewParent({ ...newParent, err: "Choose a Served Market." });
      if (groups.some((g) => g.parent1 === newParent.name && g.parent2 === newParent.market && g.items.length > 0)) {
        return setNewParent({ ...newParent, err: `“${keyOf(newParent.name, newParent.market)}” already exists.` });
      }
      setNodeChoice({ customer: newParent.name, market: newParent.market });
      setNewParent(null);
      setMessage({ kind: "ok", text: `“${keyOf(newParent.name, newParent.market)}” ready. Add its first Technology Node; it is saved with that node.` });
      return;
    }
    const parent2 = "";
    if (groups.some((g) => g.key.toLowerCase() === keyOf(name, parent2).toLowerCase())) return setNewParent({ ...newParent, err: `“${keyOf(name, parent2)}” already exists.` });
    setNewParent(null);
    if (dep.parentLookup) {
      // The parent is a value of a dropdown list (Customer / Top Competitor / Served Market): it is added there.
      void run(
        async () => (await ciApi.addLookup({ category: dep.parentLookup!, value: name })).lookup,
        `“${name}” added to ${dep.parentLookup}. Now add its values.`,
        (lookup) => lookupData.mutate((d) => ({ ...d, lookups: [...d.lookups, lookup] }))
      );
    }
  }

  const listRows = (c: string): string[][] => listValues(c).map((l) => [c, l.value]);
  const workbookAll = (): XlsxSheet[] => [
    { name: DROPDOWN_SHEET, rows: [["Category", "Name"], ...DROPDOWN_CATEGORIES.flatMap(listRows)] },
    ...DEPENDENTS.map((x) => ({ name: x.sheet, rows: [x.headers, ...entries.filter((e) => e.list === x.id).map(sheetRow)] })),
  ];

  /**
   * Adds the new values from the workbook: "Dropdown Lists" rows to ci_lookup, each
   * dependent sheet's rows to ci_lookup_dependent. Existing values, unknown lists and rows the
   * server refuses (a parent that is not in its dropdown list, an unknown Fab Region) are skipped and reported.
   */
  async function importValues(file: File): Promise<ExcelImportResult> {
    const skip: string[] = [];
    let ok = 0;
    const sheets = await readWorkbook(file);

    // 1) Dropdown values: checked here for the obvious, then all sent in ONE call (the server checks every row again).
    const drop = findSheet(sheets, DROPDOWN_SHEET);
    const seen = new Set(all.map((l) => `${l.category}|${l.value.toLowerCase()}`));
    const dropItems: { category: string; value: string; where: string }[] = [];
    const dropRows = drop ? drop.rows : [];
    for (let i = 0; i < dropRows.length; i++) {
      const [rawCategory = "", rawValue = ""] = dropRows[i];
      if (i === 0 && /^category$/i.test(rawCategory)) continue;
      const where = `${drop?.name} row ${i + 1}`;
      const cat = DROPDOWN_CATEGORIES.find((c) => c.toLowerCase() === rawCategory.toLowerCase());
      const value = rawValue.trim();
      if (!cat) skip.push(`${where}: unknown category “${rawCategory}”`);
      else if (!value) skip.push(`${where}: no name`);
      else if (seen.has(`${cat}|${value.toLowerCase()}`)) skip.push(`${where}: “${value}” already exists in ${cat}`);
      else {
        seen.add(`${cat}|${value.toLowerCase()}`);
        dropItems.push({ category: cat, value, where });
      }
    }
    try {
      for (let at = 0; at < dropItems.length; at += 500) {
        const chunk = dropItems.slice(at, at + 500);
        const res = await ciApi.addLookupsBulk(chunk.map(({ category, value }) => ({ category, value })));
        res.results.forEach((r, n) => (r.ok ? ok++ : skip.push(`${chunk[n].where}: ${r.error}`)));
      }
    } catch (e) {
      skip.push(`Dropdown Lists: ${e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "could not be added"}`);
    }

    // 2) Dependent values, after the dropdown values (a new Top Competitor / Served Market can then be a parent): ONE call as well.
    const existing = new Set(entries.map((e) => `${e.list}|${sheetRow(e).join("|").toLowerCase()}`));
    const depItems: { body: DependentAddRequest; where: string }[] = [];
    for (const x of DEPENDENTS) {
      const sheet = findSheet(sheets, x.sheet);
      if (!sheet) continue;
      for (let i = 0; i < sheet.rows.length; i++) {
        const cells = sheet.rows[i].map((c) => c.trim());
        if (i === 0 && cells[0]?.toLowerCase() === x.headers[0].toLowerCase()) continue;
        const where = `${sheet.name} row ${i + 1}`;
        const key = `${x.id}|${cells.slice(0, x.headers.length).join("|").toLowerCase()}`;
        if (cells.slice(0, x.headers.length).some((c) => !c)) skip.push(`${where}: ${x.headers.join(", ")} are all needed`);
        else if (existing.has(key)) skip.push(`${where}: already exists`);
        else {
          existing.add(key);
          depItems.push({
            where,
            body:
              x.id === "fab"
                ? { list: "fab", parent1: cells[0], value: cells[1], region: cells[2] }
                : x.id === "node"
                  ? { list: "node", parent1: cells[0], parent2: cells[1], value: cells[2] }
                  : { list: x.id, parent1: cells[0], value: cells[1] },
          });
        }
      }
    }
    try {
      for (let at = 0; at < depItems.length; at += 500) {
        const chunk = depItems.slice(at, at + 500);
        const res = await ciApi.addDependentsBulk(chunk.map((c) => c.body));
        res.results.forEach((r, n) => (r.ok ? ok++ : skip.push(`${chunk[n].where}: ${r.error}`)));
      }
    } catch (e) {
      skip.push(`Dependent lists: ${e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "could not be added"}`);
    }

    setMessage({ kind: skip.length ? "warn" : "ok", text: `Import finished: ${ok} value${ok === 1 ? "" : "s"} added, ${skip.length} skipped.` });
    await Promise.all([lookupData.refresh(), dependent.refresh()]);
    return { ok, skip };
  }

  async function exportAll() {
    await downloadXlsx("CI_Lookups.xlsx", workbookAll());
    setMessage({ kind: "ok", text: "Exported all lookups to Excel." });
  }

  const pick = (id: string) => {
    setSelected(id);
    setMessage(null);
    setNewValue("");
    setNewRegion("");
  };
  const disabledAll = lookupData.notConfigured || lookupData.loading;

  return (
    <>
      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {lookupData.errorMessage && <StatusBanner message={{ kind: "bad", text: lookupData.errorMessage }} />}
      {dependent.data && dependent.data.issues.length > 0 && (
        <StatusBanner message={{ kind: "warn", text: `Some dependent-list rows were left out: ${dependent.data.issues.slice(0, 3).join(" ")}${dependent.data.issues.length > 3 ? ` (+${dependent.data.issues.length - 3} more)` : ""}` }} />
      )}

      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-muted">Dropdown values and dependent lists used in the grid form</span>
        <span className="flex-1" />
        <Button variant="outline" onClick={() => setImporting(true)} disabled={disabledAll}>
          <Upload className="h-4 w-4" /> Import from Excel
        </Button>
        <Button onClick={() => void exportAll()} disabled={disabledAll}>
          <Download className="h-4 w-4" /> Export to Excel
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="overflow-y-auto p-1.5">
          <GroupHeading>Dropdown lists</GroupHeading>
          {DROPDOWN_CATEGORIES.map((c) => (
            <ListButton key={c} label={c} count={lookupData.data ? countFor(c) : null} active={selected === `l:${c}`} onClick={() => pick(`l:${c}`)} />
          ))}
          <GroupHeading>Dependent lists</GroupHeading>
          {DEPENDENTS.map((x) => (
            <ListButton key={x.id} label={x.name} count={dependent.data ? totalOf(x.id) : null} active={selected === `d:${x.id}`} onClick={() => pick(`d:${x.id}`)} />
          ))}
        </Card>

        {!dep ? (
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <PanelHeader title={category} count={`${values.length} values`} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {lookupData.notConfigured ? (
                <NotConnectedState what="Dropdown values" pending={lookupData.pendingTables} />
              ) : lookupData.loading ? (
                <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
              ) : values.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-muted">No values yet.</p>
              ) : (
                values.map((l, i) => (
                  <ValueRow
                    key={l.id}
                    n={i + 1}
                    value={l.value}
                    sub={hasUsage ? `used by ${usage[`${category}|${l.value}`] ?? 0} rows` : undefined}
                    busy={busy}
                    onRename={(v) =>
                      v &&
                      v !== l.value &&
                      void run(
                        () => ciApi.renameLookup(l.id, v),
                        `Renamed to “${v}”. Existing rows keep their saved value.`,
                        () => lookupData.mutate((d) => ({ ...d, lookups: d.lookups.map((x) => (x.id === l.id ? { ...x, value: v } : x)) }))
                      )
                    }
                    onRemove={() =>
                      setConfirm({
                        label: l.value,
                        run: () =>
                          void run(
                            () => ciApi.removeLookup(l.id),
                            `Removed “${l.value}”. Existing rows keep it.`,
                            () => lookupData.mutate((d) => ({ ...d, lookups: d.lookups.map((x) => (x.id === l.id ? { ...x, active: false } : x)) }))
                          ),
                      })
                    }
                  />
                ))
              )}
            </div>
            <div className="shrink-0 border-t border-border p-3">
              <div className="flex gap-2">
                <Input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addDropdown()}
                  placeholder={`New value for ${category}`}
                  aria-label={`New value for ${category}`}
                  disabled={lookupData.notConfigured}
                />
                <Button onClick={addDropdown} disabled={busy || !newValue.trim() || lookupData.notConfigured}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-muted">{REMOVE_NOTE}</p>
            </div>
          </Card>
        ) : (
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <PanelHeader title={dep.name} count={`${totalOf(dep.id)} values`} />
            {dependent.notConfigured ? (
              <NotConnectedState what="Dependent lists" pending={dependent.pendingTables} />
            ) : dependent.loading ? (
              <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
            ) : dependent.errorMessage ? (
              <p className="py-10 text-center text-[13px] text-danger">{dependent.errorMessage}</p>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
                  <label className="text-[11px] font-bold uppercase tracking-wide text-muted" htmlFor="dep-parent">
                    {dep.id === "node" ? "Customer" : dep.parent}
                  </label>
                  {dep.id === "fab" && (
                    <Input className="h-8 max-w-[180px] text-[13px]" value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} placeholder="Filter customers" aria-label="Filter customers" />
                  )}
                  {dep.id === "node" ? (
                    <>
                      <select
                        id="dep-parent"
                        value={nodeCustomer}
                        onChange={(e) => setNodeChoice({ customer: e.target.value, market: nodeMarket })}
                        className="h-8 min-w-[180px] max-w-[300px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-foreground"
                        aria-label="Customer"
                      >
                        {nodeCustomers.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <label className="text-[11px] font-bold uppercase tracking-wide text-muted" htmlFor="dep-market">
                        Served Market
                      </label>
                      <select
                        id="dep-market"
                        value={nodeMarket}
                        onChange={(e) => setNodeChoice({ customer: nodeCustomer, market: e.target.value })}
                        className="h-8 min-w-[160px] max-w-[260px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-foreground"
                        aria-label="Served Market"
                      >
                        {markets.map((m) => (
                          <option key={m} value={m}>
                            {m} ({entries.filter((e) => e.list === "node" && e.parent1 === nodeCustomer && e.parent2 === m).length})
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                  <select
                    id="dep-parent"
                    value={group?.key ?? ""}
                    onChange={(e) => setParentChoice({ ...parentChoice, [dep.id]: e.target.value })}
                    className="h-8 min-w-[200px] max-w-[420px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-foreground"
                    aria-label={dep.parent}
                  >
                    {shownGroups.map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.key} ({g.items.length})
                      </option>
                    ))}
                  </select>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setNewParent({ name: "", market: "", err: "" })} disabled={busy}>
                    <Plus className="h-3.5 w-3.5" /> New {dep.parent}
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {!group ? (
                    <p className="py-10 text-center text-[13px] text-muted">{dep.id === "node" ? (markets.length ? "No customers yet. Add them under Dropdown lists > Customer." : "No Served Market values yet. Add them under Dropdown lists.") : "No values yet."}</p>
                  ) : group.items.length === 0 ? (
                    <p className="py-10 text-center text-[13px] text-muted">
                      No {dep.child} values under {group.key} yet.
                    </p>
                  ) : (
                    group.items.map((e, i) => (
                      <ValueRow
                        key={e.id}
                        n={i + 1}
                        value={e.value}
                        pill={e.region}
                        regions={dep.id === "fab" ? regions : undefined}
                        busy={busy}
                        onRename={(v, r) => {
                          const body = { ...(v && v !== e.value ? { value: v } : {}), ...(dep.id === "fab" && r && r !== e.region ? { region: r } : {}) };
                          if (Object.keys(body).length) {
                            void run(
                              () => ciApi.renameDependent(e.id, body),
                              "Saved.",
                              () => dependent.mutate((d) => ({ ...d, entries: d.entries.map((x) => (x.id === e.id ? { ...x, ...body } : x)) })),
                              "dependent"
                            );
                          }
                        }}
                        onRemove={() =>
                          setConfirm({
                            label: e.value,
                            run: () =>
                              void run(
                                () => ciApi.removeDependent(e.id),
                                `Removed “${e.value}”. Existing rows keep it.`,
                                () => dependent.mutate((d) => ({ ...d, entries: d.entries.filter((x) => x.id !== e.id) })),
                                "dependent"
                              ),
                          })
                        }
                      />
                    ))
                  )}
                </div>
                <div className="shrink-0 border-t border-border p-3">
                  <div className="flex flex-wrap gap-2">
                    <Input
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addDependent()}
                      placeholder={`New ${dep.child}${group ? ` for ${group.key}` : ""}`}
                      aria-label={`New ${dep.child}`}
                      disabled={!group}
                    />
                    {dep.id === "fab" && (
                      <select value={newRegion} onChange={(e) => setNewRegion(e.target.value)} className="h-9 max-w-[190px] rounded-md border border-border-strong bg-surface px-2 text-[13px]" aria-label="Fab Region">
                        <option value="">Fab Region…</option>
                        {regions.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    )}
                    <Button onClick={addDependent} disabled={busy || !group || !newValue.trim()}>
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                  </div>
                  <p className="mt-2 text-[12px] text-muted">{dep.note}</p>
                </div>
              </>
            )}
          </Card>
        )}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader title="Delete value?" onClose={() => setConfirm(null)} />
          <DialogBody className="space-y-2 text-[13px] text-foreground">
            <p>
              Are you sure you want to delete <b>“{confirm?.label}”</b>?
            </p>
            <p className="text-muted">It will stop appearing in new dropdowns. Existing rows keep their saved value.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                c?.run();
              }}
              disabled={busy}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newParent !== null && dep !== null} onOpenChange={(o) => !o && setNewParent(null)}>
        <DialogContent>
          <DialogHeader title={`New ${dep?.parent ?? ""}`} onClose={() => setNewParent(null)} />
          <DialogBody className="space-y-3 text-[13px] text-foreground">
            {dep?.id === "node" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-muted">Customer</span>
                  <select
                    autoFocus
                    value={newParent?.name ?? ""}
                    onChange={(e) => newParent && setNewParent({ ...newParent, name: e.target.value, err: "" })}
                    className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px]"
                  >
                    <option value="">Choose…</option>
                    {nodeCustomers.map((cu) => (
                      <option key={cu}>{cu}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-muted">Served Market</span>
                  <select
                    value={newParent?.market ?? ""}
                    onChange={(e) => newParent && setNewParent({ ...newParent, market: e.target.value, err: "" })}
                    className="h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px]"
                  >
                    <option value="">Choose…</option>
                    {markets.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-muted">{dep?.parent}</span>
              <Input
                autoFocus
                value={newParent?.name ?? ""}
                onChange={(e) => newParent && setNewParent({ ...newParent, name: e.target.value, err: "" })}
                onKeyDown={(e) => e.key === "Enter" && createParent()}
                placeholder={`New ${dep?.parent}`}
              />
            </label>
            )}
            {newParent?.err && <p className="text-danger">{newParent.err}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewParent(null)}>
              Cancel
            </Button>
            <Button onClick={createParent}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExcelImportDialog
        open={importing}
        title="Import lookups from Excel"
        help="Use the Excel file from Export to Excel. Sheets: Dropdown Lists, Product Names, Process Locations, Fab Locations, Technology Nodes. New values are added; values that already exist are skipped."
        onClose={() => setImporting(false)}
        onDownload={exportAll}
        run={importValues}
      />
    </>
  );
}
