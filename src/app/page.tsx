"use client";

import * as React from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Database, History, ListTree, Plus, Table2, Upload, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { AuditDrawer } from "@/components/ci/audit-drawer";
import { NotConnectedState } from "@/components/ci/not-connected";
import { useCiSession } from "@/context/ci-session-context";
import { useCiData } from "@/hooks/use-ci-data";
import { ciApi } from "@/lib/ci/api";
import { cn } from "@/lib/utils";
import type { HomeRecentRow } from "@/types/ci-api";

/*
 * Home — the CI Prototype's landing screen: a greeting, the most recently
 * updated rows in the signed-in person's scope, quick actions, and an "at a
 * glance" panel.
 *
 * Every number and row comes from GET /api/home: corp_marketing_dev.ci.ci_main,
 * limited to the person's scope on the server (Corporate Marketing sees every live
 * row). Until the table is reachable those panels say so; nothing is invented. The
 * prototype's "Emails received" tile is left out (CI has no in-app mailbox), and so
 * is "N open for you to edit": editing is not enabled yet.
 */

const DAY_MS = 86_400_000;

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Whole days since an ISO date/time (0 = today). */
function daysAgo(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3.5 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent-bg"
    >
      <Icon className="h-4 w-4 text-accent" />
      {label}
    </Link>
  );
}

export default function HomePage() {
  const { data: session } = useSession();
  const { user } = useCiSession();
  const records = useCiData(() => ciApi.home());
  const [audit, setAudit] = React.useState<HomeRecentRow | null>(null);

  const rowCount = records.data?.rows ?? 0;
  const isCm = user?.role === "CM";
  const firstName = (user?.name ?? session?.user?.name ?? "").split(" ")[0];

  const recent = records.data?.recent ?? [];
  const glance = { rows: rowCount, customers: records.data?.customers ?? 0, competitors: records.data?.competitors ?? 0 };

  const actions: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { href: "/competitive-info?add=1", icon: Plus, label: "Add a new row" },
    { href: "/competitive-info", icon: Table2, label: "Open the full grid" },
    ...(isCm
      ? [
          { href: "/competitive-ff", icon: Database, label: "Competitive FF" },
          { href: "/import", icon: Upload, label: "Import rows from Excel" },
          { href: "/user-management", icon: Users, label: "Manage users" },
          { href: "/lookups", icon: ListTree, label: "Lookups" },
        ]
      : [{ href: "/login-history", icon: History, label: "My login history" }]),
  ];

  return (
    <>
      <PageHeader title="Home" description="Welcome to the Competitive Intelligence workspace" />

      <div className="grid min-h-0 gap-4 pb-2">
        <div>
          <p className="text-[11.5px] font-bold uppercase tracking-[0.12em] text-muted">ASM · Competitive Intelligence</p>
          <h2 className="mt-1 text-[28px] font-semibold leading-tight text-foreground">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}.
          </h2>
          {user && !records.notConfigured && !records.loading && !records.errorMessage ? (
            <p className="mt-1 text-[14px] text-foreground">
              {rowCount.toLocaleString("en-US")} row{rowCount === 1 ? "" : "s"} {rowCount === 1 ? "is" : "are"} in your view.{" "}
              <span className="text-muted">
                Signed in as {user.name} ({isCm ? "Corporate Marketing" : "Account Team"}).
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[14px] text-muted">
              {records.loading ? "Loading your view…" : "Your rows will be summarised here once the CI database is connected."}
            </p>
          )}
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-[3fr_2fr]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <div>
                <p className="text-[15px] font-semibold text-foreground">Recently updated rows</p>
                <p className="text-[12.5px] text-muted">
                  {recent.length > 0 ? `Latest ${recent.length} in your scope · newest first` : "Newest rows in your scope"}
                </p>
              </div>
              <Link href="/competitive-info" className="rounded-md px-1.5 py-1 text-[13px] font-semibold text-foreground hover:bg-accent-bg">
                View all
              </Link>
            </div>
            {records.notConfigured ? (
              <NotConnectedState what="Recently updated rows" pending={records.pendingTables} />
            ) : records.loading ? (
              <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
            ) : records.errorMessage ? (
              <p className="py-10 text-center text-[13px] text-danger">{records.errorMessage}</p>
            ) : recent.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-muted">No rows in your scope yet.</p>
            ) : (
              recent.map((r) => {
                const days = daysAgo(r.updatedAt);
                const fresh = days !== null && days <= 7;
                return (
                  <button
                    key={r.recordId}
                    type="button"
                    onClick={() => setAudit(r)}
                    className="flex w-full items-center gap-3.5 border-b border-border px-5 py-3 text-left last:border-b-0 hover:bg-surface-alt"
                  >
                    <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]", fresh ? "bg-success-bg text-success" : "bg-surface-alt text-muted")}>
                      <History className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="block text-[14.5px] text-foreground">{r.applicationId || r.recordId}</b>
                      <small className="block truncate text-[12.5px] text-muted">
                        {r.customer} / {r.servedMarket} · {r.quarter} {r.year}
                      </small>
                    </span>
                    {days !== null && (
                      <span className={cn("rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", fresh ? "bg-success-bg text-success" : "bg-surface-alt text-muted")}>
                        {days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </Card>

          <div className="grid gap-4">
            <Card className="overflow-hidden">
              <div className="border-b border-border px-5 py-3.5">
                <p className="text-[15px] font-semibold text-foreground">Quick actions</p>
                <p className="text-[12.5px] text-muted">Jump straight in</p>
              </div>
              <div className="flex flex-wrap gap-2.5 p-4">
                {actions.map((a) => (
                  <QuickAction key={a.href + a.label} {...a} />
                ))}
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border px-5 py-3.5">
                <p className="text-[15px] font-semibold text-foreground">At a glance</p>
                <p className="text-[12.5px] text-muted">Within your scope</p>
              </div>
              {records.notConfigured ? (
                <p className="px-5 py-6 text-[13px] text-muted">Shown once the CI Competitive Info table is configured.</p>
              ) : (
                <div className="grid grid-cols-3 gap-px bg-border">
                  {[
                    [glance.rows, "Rows"],
                    [glance.customers, "Customers"],
                    [glance.competitors, "Competitors"],
                  ].map(([value, label]) => (
                    <div key={label} className="bg-surface px-5 py-3.5">
                      <b className="block text-[24px] font-semibold tabular-nums text-foreground">
                        {records.loading ? "—" : Number(value).toLocaleString("en-US")}
                      </b>
                      <span className="text-[12.5px] text-muted">{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <AuditDrawer record={audit} onClose={() => setAudit(null)} />
    </>
  );
}
