"use client";

import { PageHeader } from "@/components/layout/page-header";
import { RoleGuard } from "@/components/ci/role-guard";
import { ExcelRowsPanel } from "@/components/ci/import/excel-rows-panel";

/**
 * Import — one card, as in the approved prototype (Draft_Version1): download the
 * template, choose an Excel file, Validate, then Import valid rows. Corporate
 * Marketing only; the server enforces the same role on every import call.
 *
 * The prototype has no Historic load or Bulk update tab, so they are not shown.
 * Their panels (historic-load-panel.tsx, bulk-update-panel.tsx) are unchanged and
 * can be put back as tabs here if they are wanted.
 */
export default function ImportPage() {
  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader title="Import" description="Add many rows at once from an Excel file (Corporate Marketing only)" />
      <ExcelRowsPanel />
    </RoleGuard>
  );
}
