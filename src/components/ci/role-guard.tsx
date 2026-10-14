"use client";

import { ShieldAlert } from "lucide-react";
import { useCiSession } from "@/context/ci-session-context";
import { Card, CardContent } from "@/components/ui/card";
import { CI_ROLE_LABELS, type CiRole } from "@/types/ci";

/**
 * Page-level access check (for the CI roles). The server enforces the same roles on every API call; this only
 * keeps a person from landing on a screen their role can't use. While the
 * CI database isn't connected no role exists yet, so the screen renders and
 * shows its own "not yet connected" state.
 */
export function RoleGuard({ roles, children }: { roles: CiRole[]; children: React.ReactNode }) {
  const { user, loading, dataConnected } = useCiSession();
  if (loading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-[13px] text-muted">Loading…</CardContent>
      </Card>
    );
  }
  if (!dataConnected || (user && roles.includes(user.role))) return <>{children}</>;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted">
        <ShieldAlert className="h-5 w-5 text-warning" />
        <p className="font-medium text-foreground">{roles.map((r) => CI_ROLE_LABELS[r]).join(" or ")} role required</p>
        <p>{user ? "Your role doesn't include this screen." : "Your account has no CI User Management record."}</p>
      </CardContent>
    </Card>
  );
}
