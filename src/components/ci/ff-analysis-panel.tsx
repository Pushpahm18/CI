"use client";

import * as React from "react";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/input";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner } from "@/components/ci/status-banner";
import { ApiError, ciApi, isNotConfigured } from "@/lib/ci/api";
import { FIELD_BY_KEY } from "@/lib/ci/field-spec";
import {
  FF_FILTER_KEYS,
  FF_GROUP_KEYS,
  FF_MEASURES,
  type FfAggregate,
  type FfAnalysisResponse,
  type FfFilterKey,
  type FfFilters,
  type FfGroupKey,
  type FfMeasure,
} from "@/lib/ci/ff-analysis";
import { downloadXlsx } from "@/lib/xlsx";
import { cn } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const label = (key: string) => FIELD_BY_KEY[key as keyof typeof FIELD_BY_KEY].label;
const currencyName = (c: string) => c || "no currency";

function Stat({ value, text }: { value: string; text: string }) {
  return (
    <Card className="px-3.5 py-3">
      <p className="text-[22px] font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[12px] text-muted">{text}</p>
    </Card>
  );
}

/** One multi-select filter: "All" until something is ticked. */
function MultiSelect({ name, options, value, onChange }: { name: string; options: string[]; value: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const [find, setFind] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const away = (e: MouseEvent) => rootRef.current && !rootRef.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  const shown = options.filter((o) => o.toLowerCase().includes(find.toLowerCase()));
  const summary = value.length === 0 ? "All" : value.length === 1 ? value[0] : `${value.length} selected`;
  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "inline-flex h-7 max-w-[15rem] items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors",
          value.length ? "border-accent-bg-strong bg-accent-bg text-accent" : "border-border-strong bg-surface text-muted hover:bg-accent-bg hover:text-accent"
        )}
      >
        <span className="font-medium">{name}</span>
        <b className="max-w-[7rem] truncate">{summary}</b>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1.5 max-h-72 w-60 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
          {options.length > 8 && (
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={`Search ${name}`}
              aria-label={`Search ${name}`}
              className="mb-1 h-7 w-full rounded-md border border-border-strong bg-surface px-2 text-[12.5px] focus:border-accent focus:outline-none"
            />
          )}
          <div className="mb-1 flex gap-2 px-1">
            <button type="button" className="text-[12px] font-medium text-accent" onClick={() => onChange(options)}>
              Select all
            </button>
            <button type="button" className="text-[12px] font-medium text-muted hover:text-danger" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          {shown.map((o) => (
            <label key={o} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent-bg">
              <Checkbox checked={value.includes(o)} onChange={() => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o])} />
              <span className="truncate">{o}</span>
            </label>
          ))}
          {shown.length === 0 && <p className="px-2.5 py-1.5 text-[12.5px] text-muted">No match</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Competitive FF "Analysis" tab (CI Prototype). Every number comes from Databricks, calculated over all live ci_main rows that match
 * the filters (server/ci/competitive-ff/analysis.ts). Revenue is shown per currency, never added across currencies; a blank value
 * stays blank.
 */
export function FfAnalysisPanel() {
  const [filters, setFilters] = React.useState<FfFilters>({});
  const [group, setGroup] = React.useState<FfGroupKey>("customer");
  const [measure, setMeasure] = React.useState<FfMeasure>("quantity");
  const [currency, setCurrency] = React.useState<string | null>(null);
  // `key` is the request the data / error belongs to; while it differs from the current request, the new one is still being calculated.
  const [state, setState] = React.useState<{ key: string; data: FfAnalysisResponse | null; error: unknown }>({ key: "", data: null, error: null });

  const requestKey = JSON.stringify([filters, group]);
  React.useEffect(() => {
    let cancelled = false;
    ciApi.ffAnalysis(filters, group).then(
      (data) => !cancelled && setState({ key: requestKey, data, error: null }),
      (error: unknown) => !cancelled && setState({ key: requestKey, data: null, error })
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey is the serialised [filters, group]
  }, [requestKey]);

  const { data, error } = state;
  const loading = state.key !== requestKey;
  const activeCount = Object.values(filters).filter((v) => v && v.length).length;

  const currencies = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of [...(data?.groups ?? []), ...(data?.periods ?? [])]) for (const r of a.revenue) set.add(r.currency);
    return Array.from(set).sort();
  }, [data]);
  const activeCurrency = currency !== null && currencies.includes(currency) ? currency : (currencies[0] ?? "");

  const valueOf = (a: FfAggregate): number =>
    measure === "quantity" ? a.quantity : measure === "rows" ? a.rows : (a.revenue.find((r) => r.currency === activeCurrency)?.amount ?? 0);
  const measureLabel = FF_MEASURES.find((m) => m.key === measure)!.label + (measure === "revenue" ? ` (${currencyName(activeCurrency)})` : "");
  const revenueText = (a: FfAggregate) => a.revenue.map((r) => `${r.currency ? r.currency + " " : ""}${fmt(r.amount)}`).join(" · ");

  const ranked = React.useMemo(() => [...(data?.groups ?? [])].sort((a, b) => valueOf(b) - valueOf(a)), [data, measure, activeCurrency]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = ranked.slice(0, 10);
  const topMax = Math.max(...top.map(valueOf), 1);
  const periods = data?.periods ?? [];
  const periodMax = Math.max(...periods.map(valueOf), 1);

  async function exportSummary() {
    if (!data) return;
    await downloadXlsx(`CI_FF_Summary_by_${label(group).replace(/\W+/g, "_")}.xlsx`, [
      {
        name: "Summary",
        rows: [
          [label(group), "Rows", "Order quantity", ...currencies.map((c) => `Revenue (${currencyName(c)})`)],
          ...ranked.map((g) => [g.key, g.rows, g.quantity, ...currencies.map((c) => g.revenue.find((r) => r.currency === c)?.amount ?? "")]),
        ],
      },
    ]);
  }

  if (isNotConfigured(error)) return <NotConnectedState what="The flat file" pending={error instanceof ApiError ? error.details : []} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
      {error ? <StatusBanner message={{ kind: "bad", text: error instanceof Error ? error.message : "Failed to load." }} /> : null}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {FF_FILTER_KEYS.map((k) => (
          <MultiSelect
            key={k}
            name={label(k)}
            options={data?.options[k as FfFilterKey] ?? []}
            value={filters[k as FfFilterKey] ?? []}
            onChange={(next) => setFilters((f) => ({ ...f, [k]: next }))}
          />
        ))}
        {activeCount > 0 && (
          <button type="button" onClick={() => setFilters({})} className="text-[12.5px] font-medium text-muted hover:text-danger">
            Clear filters ({activeCount})
          </button>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void exportSummary()} disabled={!data || data.groups.length === 0}>
          <Download className="h-3.5 w-3.5" /> Export summary
        </Button>
      </div>

      {loading && <p className="text-[13px] text-muted">Calculating in Databricks…</p>}

      {data && (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat value={fmt(data.totals.rows)} text="Rows" />
            <Stat value={fmt(data.totals.customers)} text="Customers" />
            <Stat value={fmt(data.totals.competitors)} text="Competitors tracked" />
            <Stat value={fmt(data.totals.quantity)} text="Total order quantity" />
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <label htmlFor="ff-group">Group by</label>
            <select id="ff-group" value={group} onChange={(e) => setGroup(e.target.value as FfGroupKey)} className="h-7 rounded-md border border-border-strong bg-surface px-2 text-foreground">
              {FF_GROUP_KEYS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
            <label htmlFor="ff-measure">Measure</label>
            <select id="ff-measure" value={measure} onChange={(e) => setMeasure(e.target.value as FfMeasure)} className="h-7 rounded-md border border-border-strong bg-surface px-2 text-foreground">
              {FF_MEASURES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            {measure === "revenue" && (
              <>
                <label htmlFor="ff-currency">Currency</label>
                <select id="ff-currency" value={activeCurrency} onChange={(e) => setCurrency(e.target.value)} className="h-7 rounded-md border border-border-strong bg-surface px-2 text-foreground">
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {currencyName(c)}
                    </option>
                  ))}
                </select>
                <span>Revenue is never added across currencies.</span>
              </>
            )}
          </div>

          {data.totals.rows === 0 ? (
            <Card className="p-6 text-center text-[13px] text-muted">No rows match these filters.</Card>
          ) : (
            <>
              <div className="grid gap-3 lg:grid-cols-2">
                <Card className="p-4">
                  <p className="mb-2 text-[13px] font-semibold text-foreground">
                    {measureLabel} by {label(group)} (top 10)
                  </p>
                  <div className="grid gap-1.5">
                    {top.map((g) => (
                      <div key={g.key} className="grid grid-cols-[110px_1fr_80px] items-center gap-2.5 text-[12.5px]">
                        <span className="truncate text-foreground" title={g.key}>
                          {g.key}
                        </span>
                        <div className="h-2.5 overflow-hidden rounded-full bg-surface-alt">
                          <div className="h-full rounded-full bg-spark-teal" style={{ width: `${Math.round((valueOf(g) / topMax) * 100)}%` }} />
                        </div>
                        <span className="text-right tabular-nums text-foreground">{fmt(valueOf(g))}</span>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card className="p-4">
                  <p className="mb-2 text-[13px] font-semibold text-foreground">{measureLabel} over time (year and quarter)</p>
                  <div className="flex h-[200px] items-end gap-2.5 overflow-x-auto pt-2">
                    {periods.map((p) => (
                      <div key={`${p.year}|${p.quarter}`} className="flex min-w-[46px] flex-1 flex-col items-center justify-end gap-1">
                        <span className="text-[11.5px] font-semibold tabular-nums text-foreground">{fmt(valueOf(p))}</span>
                        <div className="w-[70%] max-w-[40px] rounded-t bg-spark-teal" style={{ height: `${Math.max(3, Math.round((valueOf(p) / periodMax) * 140))}px` }} />
                        <span className="whitespace-nowrap text-[11px] text-muted">{[p.year, p.quarter].filter(Boolean).join(" ")}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              <Card className="max-h-[320px] shrink-0 overflow-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead className="sticky top-0 bg-accent text-white">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">{label(group)}</th>
                      <th className="px-3 py-2 text-right font-semibold">Rows</th>
                      <th className="px-3 py-2 text-right font-semibold">Order quantity</th>
                      <th className="px-3 py-2 text-right font-semibold">Revenue (per currency)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((g) => (
                      <tr key={g.key} className="border-t border-border">
                        <td className="px-3 py-1.5">{g.key}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(g.rows)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(g.quantity)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{revenueText(g)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
