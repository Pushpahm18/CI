import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Shared by Dashboard (the full KPI row) and Welcome (a smaller "at a
// glance" stack) so the same metric always looks identical wherever it
// shows up, rather than two hand-tuned near-duplicates drifting apart.

export type KpiTone = "violet" | "info" | "success" | "warning" | "danger" | "gold";

// One accent per KPI, reusing the same color language as the status badges
// elsewhere in the app (success/warning/danger/info keep their existing
// meaning) plus two purely-decorative "spark" hues for metrics that aren't a
// status at all (a total, a duration). The number itself stays bold,
// high-contrast foreground text — the color lives in the icon chip and a
// 2px top rule, never in the value.
export const KPI_TONE_STYLES: Record<KpiTone, { chip: string; rule: string }> = {
  violet: { chip: "bg-spark-violet-bg text-spark-violet", rule: "accent-rule-violet" },
  info: { chip: "bg-info-bg text-info", rule: "bg-info" },
  success: { chip: "bg-success-bg text-success", rule: "bg-success" },
  warning: { chip: "bg-warning-bg text-warning", rule: "bg-warning" },
  danger: { chip: "bg-danger-bg text-danger", rule: "bg-danger" },
  gold: { chip: "bg-spark-gold-bg text-spark-gold", rule: "accent-rule-gold" },
};

export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  compact = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: KpiTone;
  /** Tighter padding/type for smaller widget contexts (e.g. Welcome's stat stack). */
  compact?: boolean;
}) {
  const styles = KPI_TONE_STYLES[tone];
  return (
    <Card className="relative overflow-hidden">
      <div className={cn("absolute inset-x-0 top-0 h-[3px]", styles.rule)} />
      <CardContent className={compact ? "p-3.5" : "p-4"}>
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</p>
          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", styles.chip)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        <p className={cn("mt-1.5 font-semibold tabular-nums text-foreground", compact ? "text-xl" : "text-2xl")}>
          {value}
        </p>
        {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
      </CardContent>
    </Card>
  );
}
