import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-alt text-muted border-border",
  accent: "bg-accent-bg text-accent border-accent-bg-strong",
  success: "bg-success-bg text-success border-success/20",
  warning: "bg-warning-bg text-warning border-warning/20",
  danger: "bg-danger-bg text-danger border-danger/20",
  info: "bg-info-bg text-info border-info/20",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        // Tester issue (status column): items-center alone centers the flex
        // line box, not the glyph baseline — leading-tight (1.25) still left
        // extra line-height above/below the text that a badge this small
        // rounds unevenly, reading as "text sits a bit high/low in the
        // pill". leading-none (1) removes that slack so items-center
        // actually centers the visible text; justify-center keeps it
        // centered horizontally too, not just left-packed against the icon
        // gap (harmless for a content-sized badge, matters if a caller ever
        // gives one a fixed/stretched width, e.g. a status column with
        // uniform badge widths).
        "inline-flex items-center justify-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
