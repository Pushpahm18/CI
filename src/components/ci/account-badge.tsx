"use client";

import { AlertTriangle, LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useCiSession } from "@/context/ci-session-context";
import { CI_ROLE_LABELS } from "@/types/ci";

/**
 * Header identity display (Microsoft account badge pattern): the
 * verified Microsoft identity, the person's real CI role once the database is
 * connected (CI Prototype role chip — Sales also shows their customers), and
 * Sign out. No role switcher.
 */
export function AccountBadge() {
  const { data: authSession } = useSession();
  const { user, session: ciSession, loading, dataConnected } = useCiSession();
  // The verified identity comes from Auth.js on the browser side and from /api/session on the server side;
  // either one is enough, so the name and email never disappear because one of the two requests is slow.
  const name = authSession?.user?.name || ciSession?.name || "";
  const email = authSession?.user?.email || ciSession?.email || "";
  if (!name && !email) return null;

  const noRecord = !loading && dataConnected && !user;
  const roleText = user
    ? `${CI_ROLE_LABELS[user.role]}${user.role === "Sales" && user.customerScope !== "All" ? ` · ${user.customerScope.join(", ")}` : ""}`
    : null;

  return (
    <div
      className={
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] " +
        (noRecord ? "border-warning/40 bg-warning-bg" : "border-border-strong bg-surface")
      }
    >
      {noRecord && <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />}
      <span className="flex flex-col items-start leading-tight">
        <span className="font-medium text-foreground">{name || email}</span>
        <span className="max-w-[320px] truncate text-[11px] text-muted" title={roleText ?? undefined}>
          {email}
          {roleText && <> &middot; {roleText}</>}
        </span>
        {noRecord && (
          <span className="text-[11px] font-medium text-warning">No CI User Management record for this email</span>
        )}
      </span>
      <button
        type="button"
        title="Sign out"
        aria-label="Sign out"
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-accent-bg hover:text-danger"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
