"use client";

import * as React from "react";

export interface PageHeaderState {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

interface PageHeaderContextValue {
  header: PageHeaderState | null;
  setHeader: (header: PageHeaderState | null) => void;
}

const PageHeaderContext = React.createContext<PageHeaderContextValue | null>(null);

/**
 * Lets each page's own <PageHeader eyebrow/title/description/actions />
 * (rendered deep inside <main>) publish its content up to AppShell's fixed
 * top bar, so the page title uses that row instead of needing its own
 * separate row below. One shared provider (AppShell), so every
 * screen using <PageHeader> gets this automatically with no per-page change.
 */
export function PageHeaderProvider({ children }: { children: React.ReactNode }) {
  const [header, setHeader] = React.useState<PageHeaderState | null>(null);
  const value = React.useMemo(() => ({ header, setHeader }), [header]);
  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeaderContext(): PageHeaderContextValue {
  const ctx = React.useContext(PageHeaderContext);
  if (!ctx) throw new Error("usePageHeaderContext must be used inside PageHeaderProvider");
  return ctx;
}
