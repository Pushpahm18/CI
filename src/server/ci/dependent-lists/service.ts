import type { SessionIdentity } from "@/server/ci/current-user";
import { STANDALONE_REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { requireConnected } from "@/server/ci/connection";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { dependentListsFrom, getDependentLookupStore, type DependentLookupRow } from "@/server/ci/databricks/dependent-lookups";
import type { DependentListsResponse } from "@/types/ci-api";

/**
 * Read-only cascading lists for the Lookups and Sequential Dropdown screens, from
 * ci_lookup_dependent. Same order of checks as the other Lookups calls: table
 * configured -> Databricks connected -> Corporate Marketing -> the read. No write
 * path exists here.
 */

export interface DependentListsDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<unknown>;
  rows(): Promise<DependentLookupRow[]>;
}

const defaultDeps: DependentListsDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.dependentLookupsView),
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  rows: async () => (await getDependentLookupStore()?.list()) ?? [],
};

export async function loadDependentLists(identity: SessionIdentity, deps: DependentListsDeps = defaultDeps): Promise<DependentListsResponse> {
  deps.requireTables();
  deps.requireConnected();
  const [, lists] = await authorizedReads(
    () => deps.authorize(identity),
    () => safely(async () => dependentListsFrom(await deps.rows()), "loaded")
  );
  return lists;
}
