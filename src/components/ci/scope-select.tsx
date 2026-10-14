"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ScopeValue } from "@/types/ci";

/**
 * User Management's MultiSelectField — a checkbox list with its own
 * "Select All" — used for a user's Customer, Served Market and Region scope.
 * "Select All" stores "All"; otherwise the specific values picked.
 *
 * `allowCustom` adds a box at the top of the list to type a value that is not
 * in the list yet (Enter adds it, and it then shows checked like the others).
 * Values already chosen but missing from `options` stay in the list so they can be unticked.
 */
export function ScopeSelect({
  options,
  value,
  onChange,
  invalid,
  placeholder = "Select…",
  allowCustom = false,
  customPlaceholder = "Add a value and press Enter",
  ariaLabel,
}: {
  options: string[];
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
  invalid?: boolean;
  placeholder?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const isAll = value === "All";
  const selected = new Set(isAll ? [] : value);
  const shown = Array.from(new Set([...options, ...selected]));

  function toggleOne(opt: string) {
    if (isAll) return;
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(Array.from(next));
  }

  function addCustom() {
    const v = draft.trim();
    if (!v || isAll) return;
    if (!selected.has(v)) onChange([...selected, v]);
    setDraft("");
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
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-surface px-2.5 py-1.5 text-left text-[13px]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent",
          invalid ? "border-2 border-danger bg-danger-bg/50" : "border-border-strong",
          selected.size === 0 && !isAll ? "text-muted-2" : "text-foreground"
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-semibold hover:bg-accent-bg">
            <Checkbox checked={isAll} onChange={() => onChange(isAll ? [] : "All")} />
            Select All
          </label>
          <div className="my-1 border-t border-border" />
          {allowCustom && (
            <div className="px-1.5 pb-1.5">
              <input
                value={draft}
                disabled={isAll}
                placeholder={customPlaceholder}
                aria-label={ariaLabel ? `${ariaLabel}: add a value` : "Add a value"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[12.5px] focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          )}
          {shown.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[12.5px] text-muted-2">No options found</p>
          ) : (
            shown.map((opt) => (
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

export function scopeLabel(scope: ScopeValue, allText: string): string {
  if (scope === "All") return allText;
  return scope.length ? scope.join(", ") : "None";
}
