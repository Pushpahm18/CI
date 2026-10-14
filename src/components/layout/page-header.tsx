"use client";

import * as React from "react";
import { usePageHeaderContext } from "@/context/page-header-context";

/**
 * Publishes its content to AppShell's fixed top bar (see
 * page-header-context.tsx) instead of rendering its own row, so the page
 * title sits in the top bar rather than in a second row underneath it.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  const { setHeader } = usePageHeaderContext();

  React.useEffect(() => {
    setHeader({ eyebrow, title, description, actions });
    return () => setHeader(null);
  }, [eyebrow, title, description, actions, setHeader]);

  return null;
}
