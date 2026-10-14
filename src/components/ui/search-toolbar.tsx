"use client";

import * as React from "react";
import { RotateCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The visible search box (re-added per explicit UI request — positioned
 * immediately left of Reload/Refresh) is the same `value`/`onChange` this
 * component always accepted; it briefly went hidden during an earlier
 * vertical-space compaction pass, but every caller's underlying state/
 * wiring was untouched throughout — only the input itself was gone, never
 * the search capability.
 */
export function SearchToolbar({
  value,
  onChange,
  onRefresh,
  placeholder,
  className,
  inputWidthClass = "w-[220px] sm:w-[260px]",
}: {
  value: string;
  onChange: (v: string) => void;
  onRefresh?: () => void;
  placeholder?: string;
  className?: string;
  inputWidthClass?: string;
}) {
  const [spinning, setSpinning] = React.useState(false);

  function handleRefresh() {
    setSpinning(true);
    onRefresh?.();
    window.setTimeout(() => setSpinning(false), 450);
  }

  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)}>
      <div className={cn("relative shrink-0", inputWidthClass)}>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-2" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Search…"}
          className="h-7 w-full rounded-md border border-border-strong bg-surface pl-8 pr-2.5 text-[12.5px] text-foreground focus:border-accent focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={handleRefresh}
        title="Refresh"
        aria-label="Refresh"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-muted transition-colors hover:bg-accent-bg hover:text-accent"
      >
        <RotateCw className={cn("h-3.5 w-3.5", spinning && "animate-spin")} />
      </button>
    </div>
  );
}
