import { Database, Info } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Full empty state for a screen whose CI Databricks table(s) have no
 * configuration yet. `pending` lists the table names the server reported;
 * nothing is shown in place of the missing data — no sample values.
 */
export function NotConnectedState({ what = "Data", pending = [] }: { what?: string; pending?: string[] }) {
  return (
    <EmptyState
      icon={<Database className="h-7 w-7" />}
      title="CI database table configuration is pending"
      description={
        pending.length > 0
          ? `${what} needs these tables to be configured: ${pending.join(", ")}.`
          : `${what} will appear here once the CI Databricks tables are configured.`
      }
    />
  );
}

/** Thin app-wide notice shown under the top bar while CI table configuration is pending. */
export function NotConnectedBanner() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-info/20 bg-info-bg px-5 py-1.5 text-[12px] text-info">
      <Info className="h-3.5 w-3.5 shrink-0" />
      <span>
        CI database table configuration is pending — each screen shows which tables it still needs, and user roles can&apos;t
        be resolved until the CI users table is configured, so every screen is listed for review.
      </span>
    </div>
  );
}
