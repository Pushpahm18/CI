"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ciApi } from "@/lib/ci/api";
import { directoryAliases } from "@/lib/ci/identity-email";
import type { DirectoryUser, DirectoryUsersResponse } from "@/types/ci-api";

/*
 * Picks the person to add from the Microsoft Entra ID directory (read through
 * /api/user-access/directory, Corporate Marketing only). The browser's choice is a
 * convenience: the server checks the email against the directory again on Save and
 * stores the directory's own name and email.
 *
 * Typing a name and email by hand is offered ONLY when the server says so
 * (manualEntryAllowed - local development while the directory cannot be read).
 */

const MAX_SHOWN = 8;

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; data: DirectoryUsersResponse };

export function DirectoryUserPicker({
  userName,
  email,
  existingEmails,
  nameError,
  emailError,
  onSelect,
  onType,
}: {
  userName: string;
  email: string;
  /** Lower-cased emails that already have a CI record (one record per email). */
  existingEmails: Set<string>;
  nameError?: string;
  emailError?: string;
  onSelect: (user: { userName: string; email: string }) => void;
  onType: (field: "userName" | "email", value: string) => void;
}) {
  const [load, setLoad] = React.useState<Load>({ state: "loading" });
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    let live = true;
    ciApi
      .userAccessDirectory()
      .then((data) => live && setLoad({ state: "ready", data }))
      .catch((e: unknown) => live && setLoad({ state: "failed", message: e instanceof Error ? e.message : "The directory could not be loaded." }));
    return () => {
      live = false;
    };
  }, []);

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || load.state !== "ready") return [];
    const users: DirectoryUser[] = load.data.users;
    return users
      .filter((u) => u.displayName.toLowerCase().includes(q) || directoryAliases(u).some((a) => a.includes(q)))
      .slice(0, MAX_SHOWN);
  }, [load, query]);

  if (load.state === "loading") return <p className="text-[12.5px] text-muted">Loading the Microsoft directory…</p>;
  if (load.state === "failed") {
    return (
      <div className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
        <p className="font-medium">The Microsoft directory could not be loaded</p>
        <p>{load.message}</p>
      </div>
    );
  }

  const { data } = load;

  if (data.manualEntryAllowed) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
          <p className="font-medium">Local development only: type the name and email by hand.</p>
          <p>{data.unavailable ?? "Microsoft directory search is not configured on this server."}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="mb-0.5 block text-[11.5px]">
              User Name <span className="text-danger">*</span>
            </Label>
            <Input className="h-8 text-[12.5px]" value={userName} onChange={(e) => onType("userName", e.target.value)} aria-invalid={Boolean(nameError)} />
            {nameError && <p className="mt-1 text-[12px] text-danger">{nameError}</p>}
          </div>
          <div>
            <Label className="mb-0.5 block text-[11.5px]">
              User Email <span className="text-danger">*</span>
            </Label>
            <Input className="h-8 text-[12.5px]" type="email" value={email} onChange={(e) => onType("email", e.target.value)} aria-invalid={Boolean(emailError)} />
            {emailError && <p className="mt-1 text-[12px] text-danger">{emailError}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (!data.configured) {
    return (
      <div className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
        <p className="font-medium">Microsoft directory search is not configured</p>
        <p>Users are added by choosing them from the Microsoft directory. An administrator must configure the Microsoft connection on the server first.</p>
      </div>
    );
  }

  const selected = Boolean(email);
  return (
    <div className="space-y-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="mb-0.5 block text-[11.5px]">
            User Name <span className="text-danger">*</span>
          </Label>
          {selected ? (
            <div className="flex gap-1.5">
              <Input className="h-8 text-[12.5px]" value={userName} readOnly aria-label="User Name" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onSelect({ userName: "", email: "" });
                  setQuery("");
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" />
              <Input
                className="h-8 pl-8 text-[12.5px]"
                value={query}
                placeholder="Search the Microsoft directory by name or email"
                onChange={(e) => setQuery(e.target.value)}
                aria-invalid={Boolean(emailError || nameError)}
                aria-label="Search the Microsoft directory"
              />
            </div>
          )}
        </div>
        <div>
          <Label className="mb-0.5 block text-[11.5px]">
            User Email <span className="text-danger">*</span>
          </Label>
          <Input className="h-8 text-[12.5px]" value={email} readOnly placeholder="Filled in when you select a user" aria-label="Email" aria-invalid={Boolean(emailError)} />
        </div>
      </div>
      {!selected && query.trim() !== "" && (
        <ul className="max-h-56 overflow-y-auto rounded-md border border-border-strong bg-surface" role="listbox" aria-label="Directory results">
          {matches.length === 0 && <li className="px-3 py-2 text-[12.5px] text-muted">No one in the directory matches “{query.trim()}”.</li>}
          {matches.map((u) => {
            const taken = directoryAliases(u).some((a) => existingEmails.has(a));
            return (
              <li key={u.id}>
                <button
                  type="button"
                  disabled={taken}
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onSelect({ userName: u.displayName, email: u.email.toLowerCase() });
                    setQuery("");
                  }}
                  className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-accent-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="text-[13px] text-foreground">{u.displayName}</span>
                  <span className="text-[12px] text-muted">
                    {u.email}
                    {taken ? " · already has a CI record" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!selected && (emailError || nameError) && <p className="text-[12px] text-danger">Select a person from the Microsoft directory.</p>}
    </div>
  );
}
