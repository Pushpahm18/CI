import * as React from "react";
import { FileSearch } from "lucide-react";

export function EmptyState({
  title = "No Data Found!",
  description = "No content matched your criteria. Try searching for something else.",
  icon,
}: {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-bg text-accent">
        {icon ?? <FileSearch className="h-7 w-7" />}
      </div>
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      <p className="max-w-xs text-[13px] text-muted">{description}</p>
    </div>
  );
}
