import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `scroll` opts a table into a panel that scrolls internally (both axes)
 * with its own frozen header row, clamped to whatever height its flex
 * parent has available — for the handful of screens where the table IS the
 * page (e.g. All Competitive Info View, Competitive FF). It requires the
 * immediate parent to be a flex column with a definite height so there's an
 * actual ceiling to clamp against; see those pages for the wrapper pattern.
 * A table shorter than that ceiling just sizes to its own content — it does
 * NOT get stretched to fill the panel — so this is also safe to use on
 * tables that only sometimes have a lot of rows. Smaller, always-short
 * embedded tables still don't need this at all and can leave `scroll` omitted.
 */
export function TableWrap({ children, scroll = false }: { children: React.ReactNode; scroll?: boolean }) {
  return (
    <div
      className={cn(
        "table-scroll overflow-x-auto rounded-lg border border-border",
        // flex-shrink (the default) + min-h-0, deliberately WITHOUT flex-1/flex-grow:
        // a short table (few rows) then sizes to its own content instead of being
        // force-stretched to fill the whole panel — no more dead white space inside
        // the border. A tall table still gets clamped to the flex parent's available
        // height (min-h-0 removes the automatic content-based floor that would
        // otherwise stop it from shrinking) and scrolls internally with the sticky
        // header once its content no longer fits.
        scroll && "flex min-h-0 flex-col overflow-y-auto"
      )}
    >
      {children}
    </div>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-[10.5px]", className)} {...props} />;
}

/**
 * Every table uses the same solid brand-color header with white text, so
 * there is no per-screen variant to apply here.
 */
export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn("bg-table-header-solid-bg text-table-header-solid-fg", className)} {...props} />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border", className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("even:bg-surface-alt hover:bg-accent-bg/60 transition-colors", className)} {...props} />;
}

// Sticky relative to TableWrap's own scrollport (only actually "sticks" when
// TableWrap is in `scroll` mode — in natural-height tables there's no internal
// scroll for it to stick against, so this is a harmless no-op there). Painted
// with its own explicit opaque background rather than relying on <thead>'s —
// a stickily-positioned cell needs to carry its own background, since that's
// exactly the kind of assumption that caused the white-header regression
// during the earlier sticky-column attempt.
export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        // align-top (not the browser's own default vertical-align: middle for
        // <th>): FilterableTH (screens/filterable-th.tsx) stacks a label +
        // an embedded <select> in some header cells, making that <tr> taller
        // than a plain single-line header — every cell in the row still
        // stretches to match (normal table behavior), so this keeps every
        // header's own text pinned to the same top line instead of some
        // looking vertically centered against a taller row than others.
        //
        // Thin white vertical separator between header columns (every
        // screen with a table, per explicit UI request) — an inset
        // box-shadow rather than border-right: <Table> sets border-collapse
        // and this cell is sticky (top-0); a collapsed border on a sticky
        // cell is a known cross-browser flake (the painted border
        // technically belongs to the adjacent, non-sticky cell, so it can
        // vanish mid-scroll). box-shadow paints on the cell itself
        // regardless of border-collapse/sticky, so it stays visible while
        // scrolling either axis. Skipped on the last cell in a row so there
        // is no stray line against the table's outer border. Applies to
        // <TH> only — <TD> (below) is untouched, so data rows get no lines.
        //
        // Tester feedback (Carly's prototype review, item 4/16: "Column
        // widths throughout the application are too wide" / "widths need
        // condensing" — My Requests, All Apps View, All Applications,
        // Application & Node View): this one component renders every
        // header cell on every one of those screens, and it was forcing
        // whitespace-nowrap — meaning every column had to be at least as
        // wide as its longest header label on one line ("Application
        // Sub-Segment", "Stretch Classification", etc.), which is the
        // single shared root cause of the app-wide over-wide columns.
        // Letting headers wrap (leading-tight keeps a 2-line header
        // compact) lets the browser size each column to its actual
        // content instead of its longest single-line label — narrower
        // columns everywhere this component is used, no per-screen changes
        // needed. Purely visual: no data, filter, or column-order logic
        // touched.
        "sticky top-0 z-10 whitespace-normal break-words bg-table-header-solid-bg px-1 py-1.5 text-left align-top text-[10.5px] font-bold leading-tight text-table-header-solid-fg [&:not(:last-child)]:[box-shadow:inset_-1px_0_0_#ffffff]",
        className
      )}
      {...props}
    />
  );
}

// Tester-reported issue (client environment): column data across every
// gallery/table was left-aligned by default (browser default for <td>).
// text-align: center handles this for every plain-text/number/Badge column,
// which is the vast majority. (An earlier attempt used display:flex directly
// on the <td> to also reach the handful of columns that wrap content in a
// block-level <div> — that broke table layout entirely in real browsers,
// pulling every cell out of its column into one stacked column. Reverted:
// <td> must stay a normal table-cell. Those few block-wrapped columns
// (multi-role/multi-value stacks, Actions-column icon rows) are centered
// individually at their own call sites via mx-auto instead — see
// admin/users/page.tsx and the Actions-column divs.)
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("px-1 py-1.5 text-center align-middle text-[10.5px] text-foreground", className)}
      {...props}
    />
  );
}
