"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowDownWideNarrow,
  ChevronsLeft,
  ChevronsRight,
  Database,
  History,
  House,
  KeyRound,
  ListTree,
  Table2,
  Upload,
  Users,
} from "lucide-react";
import { useCiSession } from "@/context/ci-session-context";
import { PageHeaderProvider, usePageHeaderContext } from "@/context/page-header-context";
import { AccountBadge } from "@/components/ci/account-badge";
import { NotConnectedBanner } from "@/components/ci/not-connected";
import { cn } from "@/lib/utils";
import { CI_ROLE_LABELS, type CiRole } from "@/types/ci";

interface NavItem {
  href: string;
  label: string;
  /** Shown instead of `label` to Sales (CI Prototype: "My Login History"). */
  salesLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: CiRole[];
}

// CI Prototype / BRD 1.1 §4 navigation — one list per role, no Admin area:
// Corporate Marketing sees every screen, including the management screens it
// now owns; Sales sees All Competitive Info View only. The server enforces
// the same roles on every API call; this only decides what is listed.
const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: House, roles: ["Sales", "CM"] },
  { href: "/competitive-info", label: "All Competitive Info View", icon: Table2, roles: ["Sales", "CM"] },
  { href: "/competitive-ff", label: "Competitive FF", icon: Database, roles: ["CM"] },
  { href: "/import", label: "Import", icon: Upload, roles: ["CM"] },
  { href: "/user-management", label: "User Management", icon: Users, roles: ["CM"] },
  { href: "/lookups", label: "Lookups", icon: ListTree, roles: ["CM"] },
  { href: "/sequential-lookup", label: "Sequential Dropdown", icon: ArrowDownWideNarrow, roles: ["CM"] },
  // CI Prototype: Corporate Marketing sees every sign-in; Sales sees their own ("My Login History").
  { href: "/user-access", label: "User Access", icon: KeyRound, roles: ["CM"] },
  { href: "/login-history", label: "Login History", salesLabel: "My Login History", icon: History, roles: ["Sales", "CM"] },
];

const COLLAPSE_KEY = "ci-sidebar-collapsed";
const COLLAPSE_EVENT = "ci-sidebar-collapse-change";

// The remembered collapsed state, read through useSyncExternalStore so the
// server render (no localStorage) and the first client render agree.
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeCollapsed(onChange: () => void): () => void {
  window.addEventListener(COLLAPSE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeCollapsed(next: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  } catch {
    // localStorage unavailable — the toggle still works via the event below.
  }
  window.dispatchEvent(new Event(COLLAPSE_EVENT));
}

/** These screens read their own Databricks tables and show their own pending/connection status (server/ci/user-management, login-history, competitive-gallery). */
const SCREENS_WITH_OWN_DATA_SOURCE = ["/user-management", "/user-access", "/login-history", "/competitive-info"];

function NavLink({ item, label, active, collapsed }: { item: NavItem; label: string; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md py-2 text-[13px] font-medium transition-colors",
        collapsed ? "justify-center px-2" : "pl-3 pr-2.5",
        active
          ? "bg-sidebar-active-bg text-sidebar-text shadow-sm"
          : "text-sidebar-text-muted hover:bg-sidebar-hover-bg hover:text-sidebar-text"
      )}
    >
      {active && (
        <span className={cn("nav-accent-gradient absolute inset-y-1 rounded-full", collapsed ? "left-0.5 w-[3px]" : "left-0 w-[3px]")} />
      )}
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

/** Renders whatever the current page's <PageHeader> published (see page-header-context.tsx). */
function TopBarPageHeader() {
  const { header } = usePageHeaderContext();
  if (!header) return <p className="text-[12px] font-medium text-muted">Competitive Intelligence</p>;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:flex-nowrap">
      <div className="min-w-0 shrink">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-[15px] font-medium leading-tight text-accent">{header.title}</h1>
          {header.eyebrow && (
            <span className="eyebrow-gradient shrink-0 rounded-full border border-accent-bg-strong px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              {header.eyebrow}
            </span>
          )}
        </div>
        {header.description && (
          <p className="mt-0.5 truncate text-[12px] leading-tight text-muted" title={header.description}>
            {header.description}
          </p>
        )}
      </div>
      {header.actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{header.actions}</div>}
    </div>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, dataConnected } = useCiSession();
  const pathname = usePathname();
  const collapsed = React.useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);

  function toggleCollapsed() {
    writeCollapsed(!collapsed);
  }

  // /login and /access-denied render on their own, without the app chrome.
  if (pathname === "/login" || pathname === "/access-denied") return <>{children}</>;

  // Navigation follows the signed-in person's real CI role. While the CI
  // database isn't connected yet no role can be resolved, so every screen is
  // listed (each one shows "CI database not yet connected") so the UI can be
  // reviewed — the server still refuses every data request until then.
  const showAll = !loading && !dataConnected;
  const allowed = (item: NavItem) => showAll || (user ? item.roles.includes(user.role) : false);
  const items = NAV.filter(allowed);
  // Screens that read their own Databricks source show their own connection
  // status, so the app-wide "CI database not yet connected" notice is hidden there.
  const ownDataSource = SCREENS_WITH_OWN_DATA_SOURCE.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const heading = showAll ? null : user ? CI_ROLE_LABELS[user.role] : null;

  return (
    <div className="flex h-screen">
      <aside
        className={cn(
          "sidebar-surface flex shrink-0 flex-col shadow-lg transition-[width] duration-200",
          collapsed ? "w-[68px]" : "w-56"
        )}
      >
        <Link
          href="/"
          title="Go to home"
          className={cn(
            "flex flex-col border-b border-sidebar-border transition-colors hover:bg-sidebar-hover-bg",
            collapsed ? "items-center gap-1.5 px-2 py-4" : "items-start gap-2 px-4 py-4"
          )}
        >
          {collapsed ? (
            <Image src="/asm-mark-white.png" alt="ASM" width={267} height={293} priority className="h-9 w-auto shrink-0" />
          ) : (
            <Image src="/asm-logo-white.png" alt="ASM" width={917} height={300} priority className="h-auto w-full max-w-[152px]" />
          )}
          {!collapsed && (
            <div className="min-w-0 w-full leading-tight">
              <p className="font-heading truncate text-sm font-medium text-sidebar-text">Competitive Intelligence</p>
              <p className="truncate text-[11px] text-sidebar-text-muted">Market share workspace</p>
            </div>
          )}
        </Link>

        <nav className={cn("flex-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}>
          {heading && !collapsed && (
            <p className="px-3 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-sidebar-text-muted">{heading}</p>
          )}
          <div className="space-y-0.5">
            {items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                label={user?.role === "Sales" && item.salesLabel ? item.salesLabel : item.label}
                active={item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/")}
                collapsed={collapsed}
              />
            ))}
          </div>
        </nav>

        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex items-center gap-2 border-t border-sidebar-border py-3 text-[11px] font-medium text-sidebar-text-muted transition-colors hover:bg-sidebar-hover-bg hover:text-sidebar-text",
            collapsed ? "justify-center px-2" : "px-4"
          )}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </aside>

      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <header className="flex min-h-[42px] shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-1.5 shadow-sm">
          <TopBarPageHeader />
          <div className="flex shrink-0 items-center gap-3">
            <AccountBadge />
          </div>
        </header>
        {showAll && !ownDataSource && <NotConnectedBanner />}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-5 py-3">{children}</main>
      </div>
    </div>
  );
}

export function AppShell(props: { children: React.ReactNode }) {
  return (
    <PageHeaderProvider>
      <AppShellInner {...props} />
    </PageHeaderProvider>
  );
}
