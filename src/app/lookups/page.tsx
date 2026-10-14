"use client";

import { PageHeader } from "@/components/layout/page-header";
import { RoleGuard } from "@/components/ci/role-guard";
import { LookupsScreen } from "@/components/ci/lookups-screen";

/** BRD 1.1 §7.6 Lookups — Corporate Marketing maintains dropdown values; new values are available immediately. */
export default function LookupsPage() {
  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader
        title="Lookups"
        description="Dropdown values and dependent lists used in the grid form. Corporate Marketing can add, rename, remove, import and export."
      />
      <LookupsScreen />
    </RoleGuard>
  );
}
