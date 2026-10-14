import { accountScopeFrom } from "@/server/ci/authorization/scope";
import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * Display-only helpers for ci_user_management rows. They never grant or deny
 * anything (authorization is server/ci/authorization/ci-access.ts) and they do
 * not fix a storage format: a scope value that is not "All" or a JSON array of
 * text is shown exactly as stored.
 */

export type ScopeDisplay = { kind: "empty" } | { kind: "all" } | { kind: "list"; values: string[] } | { kind: "raw"; text: string };

export function parseScopeText(text: string): ScopeDisplay {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (t.toLowerCase() === "all") return { kind: "all" };
  if (t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === "string" && v.trim() !== "")) {
        return { kind: "list", values: parsed.map((v: string) => v.trim()) };
      }
    } catch {
      /* fall through: shown as stored */
    }
  }
  return { kind: "raw", text: t };
}

const ROLES = ["Account Team", "Corporate Marketing"];

/** Plain-language review notes for a row, so odd records are visible instead of silently hidden. */
export function reviewNotes(user: CiUserRecordRaw, all: CiUserRecordRaw[]): string[] {
  const notes: string[] = [];
  const key = user.email.trim().toLowerCase();
  if (user.isActive === null) notes.push("Active flag is empty or unreadable");
  if (!ROLES.includes(user.role)) notes.push(user.role ? `Unrecognised role “${user.role}”` : "No role");
  if (key && all.filter((u) => u.email.trim().toLowerCase() === key && u.isActive === true).length > 1 && user.isActive === true) {
    notes.push("More than one active record for this email");
  }
  const status = user.status.trim().toLowerCase();
  if (user.isActive === true && status !== "" && status !== "active") notes.push("Status conflicts with the active flag");
  if (user.role === "Account Team") {
    const scope = accountScopeFrom(user);
    if (!scope.ok) notes.push(`Scope is invalid, so this user is denied access (${scope.reason.replace(/\.$/, "")})`);
  }
  if (user.role === "Corporate Marketing" && ["customer", "segment", "region"].some((k) => user[k as "customer"].trim() !== "All")) {
    notes.push("Corporate Marketing is not scoped; its scope columns should all be All");
  }
  return notes;
}
