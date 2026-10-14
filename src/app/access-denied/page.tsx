import Image from "next/image";
import { ShieldAlert, LogOut } from "lucide-react";
import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";

// Phase 2 — reached only when src/proxy.ts's CI access check (resolveCiAccess())
// denies a Microsoft-authenticated person. Two genuinely different causes
// land here, and they are NOT the same problem for the visitor:
//
//  - The check ran and said no: they have no active CI User Management record —
//    Corporate Marketing really does need to add them.
//  - The check itself couldn't run (proxy.ts's catch — e.g. the Databricks
//    warehouse is unreachable/exhausted) — this says NOTHING about whether
//    they're actually authorized; fails closed the same way as a genuine
//    "no" (never let an unverifiable identity through), but telling an
//    already-authorized person to "ask an admin to add you" here would be
//    actively wrong and send them chasing a fix that doesn't exist.
//
// proxy.ts marks the second case with ?reason=error so this page can tell
// them apart instead of showing one message for both. Distinct from /login
// (no Microsoft session at all) — this person IS signed in either way.
export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const session = await auth();
  const email = session?.user?.email;
  const { reason } = await searchParams;
  const isBackendError = reason === "error";
  const isRoleBlocked = reason === "role";

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar-bg px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-4 text-center">
          <Image src="/asm-logo-white.png" alt="ASM" width={917} height={300} priority className="h-auto w-full max-w-[168px]" />
          <div className="flex flex-col items-center gap-2">
            <ShieldAlert className="h-8 w-8 text-warning" />
            <h1 className="text-lg font-semibold text-foreground">
              {isBackendError ? "Couldn't verify your access" : isRoleBlocked ? "Screen not available for your role" : "Access not granted"}
            </h1>
          </div>
        </div>

        {isBackendError ? (
          <>
            <p className="text-center text-[13px] text-muted">
              {email && (
                <>
                  <span className="font-medium text-foreground">{email}</span> is signed in with Microsoft, but
                  Competitive Intelligence couldn&apos;t reach Databricks just now to confirm your access.
                </>
              )}
            </p>
            <p className="mt-2 text-center text-[13px] text-muted">
              This isn&apos;t a permissions problem — it means the check itself failed, most likely because the
              Databricks warehouse is temporarily unavailable. Please try again in a few minutes; there&apos;s nothing
              anyone needs to do here unless this keeps happening.
            </p>
          </>
        ) : isRoleBlocked ? (
          <p className="text-center text-[13px] text-muted">
            Your role can open Home and All Competitive Info View only. Corporate Marketing manages the other screens.
          </p>
        ) : (
          <>
            <p className="text-center text-[13px] text-muted">
              {email ? (
                <>
                  <span className="font-medium text-foreground">{email}</span> is signed in with Microsoft, but
                  hasn&apos;t been granted access to Competitive Intelligence yet.
                </>
              ) : (
                <>Your Microsoft account hasn&apos;t been granted access to Competitive Intelligence yet.</>
              )}
            </p>
            <p className="mt-2 text-center text-[13px] text-muted">
              Access is granted by Corporate Marketing in User Access and User Management. Ask them to add you, then sign in again.
            </p>
          </>
        )}

        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
          className="mt-6"
        >
          <Button type="submit" variant="outline" className="w-full">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
