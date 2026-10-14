"use client";

import * as React from "react";
import { Columns3 } from "lucide-react";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Show Columns" popover — the shared ColumnsMenu pattern, unchanged in
 * look and behaviour (Select All + one checkbox per column). The CI
 * Prototype's Columns picker lets every grid column be hidden.
 */
export function ColumnsMenu({
  columns,
  visible,
  onChange,
}: {
  columns: { key: string; label: string }[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const allVisible = columns.every((c) => visible.has(c.key));

  function toggleOne(key: string) {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Show Columns"
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors",
          open || !allVisible
            ? "border-accent-bg-strong bg-accent-bg text-accent"
            : "border-border-strong bg-surface text-muted hover:bg-accent-bg hover:text-accent"
        )}
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 max-h-72 w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-semibold hover:bg-accent-bg">
            <Checkbox checked={allVisible} onChange={() => onChange(allVisible ? new Set() : new Set(columns.map((c) => c.key)))} />
            Select All
          </label>
          <div className="my-1 border-t border-border" />
          {columns.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent-bg">
              <Checkbox checked={visible.has(c.key)} onChange={() => toggleOne(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
