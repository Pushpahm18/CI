"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ciApi } from "@/lib/ci/api";
import type { SessionResponse } from "@/types/ci-api";
import type { CiUser } from "@/types/ci";

interface CiSessionValue {
  loading: boolean;
  session: SessionResponse | null;
  /** The signed-in person's CI User Management record (role + scope), when the database is connected. */
  user: CiUser | null;
  /** False until the CI Databricks tables are connected. */
  dataConnected: boolean;
  refresh: () => Promise<void>;
}

const CiSessionContext = React.createContext<CiSessionValue | null>(null);

/**
 * The signed-in person's CI identity and role, from GET /api/session — the
 * real User Management record once the CI database is connected. There is
 * no role switcher and no fallback role: until the database is connected,
 * `user` stays null.
 */
export function CiSessionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const standalone = pathname === "/login" || pathname === "/access-denied";
  const [session, setSession] = React.useState<SessionResponse | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  // /login and /access-denied never load a CI session.
  const loading = !standalone && !loaded;

  const refresh = React.useCallback(async () => {
    try {
      setSession(await ciApi.session());
    } catch (error) {
      console.error("[CI] Failed to load session:", error);
      setSession(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    if (standalone) return;
    let cancelled = false;
    ciApi
      .session()
      .then((s) => !cancelled && setSession(s))
      .catch((error) => console.error("[CI] Failed to load session:", error))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [standalone]);

  const value = React.useMemo<CiSessionValue>(
    () => ({
      loading,
      session,
      user: session?.user ?? null,
      dataConnected: session?.dataStatus === "connected",
      refresh,
    }),
    [loading, session, refresh]
  );

  return <CiSessionContext.Provider value={value}>{children}</CiSessionContext.Provider>;
}

export function useCiSession(): CiSessionValue {
  const ctx = React.useContext(CiSessionContext);
  if (!ctx) throw new Error("useCiSession must be used inside CiSessionProvider");
  return ctx;
}
