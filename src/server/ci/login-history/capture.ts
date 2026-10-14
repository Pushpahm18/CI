import { decideCiAccess } from "@/server/ci/authorization/ci-access";
import { getUserRecordStore } from "@/server/ci/databricks/user-records";
import { getLoginHistoryRepository } from "@/server/ci/login-history/repository";

/**
 * Records one completed, SUCCESSFUL Microsoft sign-in (event "Signed in", result "Success") in Login History
 * (corp_marketing_dev.audit.ci_login_history). Called from the sign-in event in src/auth.ts
 * (SAMBA does the same: `events.signIn` → `recordLogin`). It fires once per completed sign-in — not on session
 * refresh — and never blocks or fails a sign-in: the repository's record() swallows its own errors, and this
 * wrapper guards the role lookup too. Failed sign-ins, sign-outs and access-denied events are NOT recorded.
 *
 * The role is the person's CI role from User Management when they have a valid record; a person who signed in with
 * Microsoft but has no CI record (they are then sent to "Access not granted") is still recorded, with no role.
 */
async function roleFor(email: string): Promise<string | undefined> {
  try {
    const records = await getUserRecordStore()?.list();
    if (!records) return undefined;
    const decision = decideCiAccess(records, email);
    return decision.allowed ? decision.role : undefined;
  } catch {
    return undefined;
  }
}

export async function recordLoginEvent(email: string, name: string): Promise<void> {
  try {
    await getLoginHistoryRepository().record(email, name, { role: await roleFor(email) });
  } catch (error) {
    console.error("[CI] login history: could not record the sign-in:", error instanceof Error ? error.message : error);
  }
}
