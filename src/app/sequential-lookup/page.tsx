"use client";

import { PageHeader } from "@/components/layout/page-header";
import { RoleGuard } from "@/components/ci/role-guard";
import { SequenceScreen } from "@/components/ci/sequence-screen";

/** BRD §7.6 Sequential Dropdown — controls non-alphabetical order (e.g. Served Market). */
export default function SequentialLookupPage() {
  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader
        title="Sequential Dropdown"
        description="Control custom, non-alphabetical ordering for dropdown fields where the business-meaningful order differs from A–Z."
      />
      <SequenceScreen />
    </RoleGuard>
  );
}
