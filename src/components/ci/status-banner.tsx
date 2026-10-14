import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StatusMessage {
  kind: "ok" | "warn" | "bad";
  text: string;
  details?: string[];
}

/** Inline result banner (success / warning / danger tokens), dismissible. */
export function StatusBanner({ message, onDismiss }: { message: StatusMessage; onDismiss?: () => void }) {
  const Icon = message.kind === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "mb-2 flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-[13px]",
        message.kind === "ok" && "border-success/30 bg-success-bg text-success",
        message.kind === "warn" && "border-warning/30 bg-warning-bg text-warning",
        message.kind === "bad" && "border-danger/30 bg-danger-bg text-danger"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{message.text}</p>
        {message.details && message.details.length > 0 && (
          <ul className="ml-5 mt-1 list-disc space-y-0.5">
            {message.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded p-0.5 opacity-70 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
