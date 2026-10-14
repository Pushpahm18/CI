"use client";

import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DirectoryUser } from "@/types/ci-api";

/**
 * The Username field on User Access, as in SAMBA: a dropdown that shows "Name (email)", opens a panel with a search box
 * ("Search by name or email…") over the whole Microsoft directory, and picks one person. The directory is loaded by the page
 * (GET /api/user-access/directory, Corporate Marketing only) and filtered here in the browser as you type.
 * A person who is already in the table is listed but cannot be picked again.
 */
export function DirectoryUserDropdown({
  users,
  loading,
  error,
  selected,
  onSelect,
  existingEmails,
}: {
  users: DirectoryUser[];
  loading: boolean;
  error: string;
  selected: { displayName: string; email: string } | null;
  onSelect: (user: { displayName: string; email: string }) => void;
  /** Lower-cased emails already in the table. */
  existingEmails: Set<string>;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.userPrincipalName.toLowerCase().includes(q));
  }, [users, query]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Username"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-left text-[13px] text-foreground",
          "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        )}
      >
        {selected ? (
          <span className="truncate">
            {selected.displayName} <span className="text-muted-2">({selected.email})</span>
          </span>
        ) : (
          <span className="truncate text-muted-2">Select…</span>
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1.5 rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-2" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              aria-label="Search the Microsoft directory"
              className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-2 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1" role="listbox" aria-label="Directory users">
            {loading ? (
              <p className="px-2.5 py-3 text-center text-[12.5px] text-muted-2">Loading organization users…</p>
            ) : error ? (
              <p className="px-2.5 py-3 text-center text-[12.5px] text-danger">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-[12.5px] text-muted-2">{users.length === 0 ? "No organization users found." : "No users found"}</p>
            ) : (
              filtered.map((u) => {
                const taken = [u.email, u.mail, u.userPrincipalName].some((a) => a && existingEmails.has(a.trim().toLowerCase()));
                return (
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    disabled={taken}
                    onClick={() => {
                      onSelect({ displayName: u.displayName, email: u.email.toLowerCase() });
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-accent-bg disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="truncate text-[13px]">{u.displayName}</span>
                    <span className="truncate text-[12px] text-muted-2">
                      {u.email}
                      {taken ? " · already in the table" : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
