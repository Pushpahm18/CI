"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Checkbox dropdown with "Select All" — the User Management Customer /
 * Segment / Region picker (SAMBA admin/users MultiSelectField pattern).
 * The value is SAMBA's stored format: "All", or "A, B, C".
 */
export function MultiSelectField({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled = false,
  invalid = false,
  compact = false,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Smaller control for dense forms. */
  compact?: boolean;
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

  const isAll = value.trim().toLowerCase() === "all";
  const selected = React.useMemo(
    () => new Set(isAll ? [] : value.split(",").map((v) => v.trim()).filter(Boolean)),
    [value, isAll]
  );
  // Keep values that are stored but not in the option list visible and removable.
  const allOptions = React.useMemo(() => Array.from(new Set([...options, ...selected])), [options, selected]);

  function toggleOne(opt: string) {
    if (isAll) return;
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(Array.from(next).join(", "));
  }

  const summary = isAll
    ? "All"
    : selected.size === 0
      ? placeholder
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} selected`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-left",
          compact ? "h-8 text-[12.5px]" : "h-9 py-1.5 text-[13px]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent",
          "disabled:cursor-not-allowed disabled:opacity-60",
          selected.size === 0 && !isAll ? "text-muted-2" : "text-foreground",
          invalid && "border-2 border-danger bg-danger-bg/50"
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && !disabled && (
        <div className="absolute left-0 right-0 z-30 mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-semibold hover:bg-accent-bg">
            <Checkbox checked={isAll} onChange={() => onChange(isAll ? "" : "All")} />
            Select All
          </label>
          <div className="my-1 border-t border-border" />
          {allOptions.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[12.5px] text-muted-2">No options found</p>
          ) : (
            allOptions.map((opt) => (
              <label
                key={opt}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent-bg",
                  isAll ? "cursor-not-allowed text-muted-2" : "cursor-pointer"
                )}
              >
                <Checkbox checked={isAll || selected.has(opt)} disabled={isAll} onChange={() => toggleOne(opt)} />
                {opt}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
