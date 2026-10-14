import type { SessionIdentity } from "@/server/ci/current-user";
import { getCiRepository, type CiRepository } from "@/server/ci/repository";
import { STANDALONE_REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { requireConnected } from "@/server/ci/connection";
import { dependentListsFrom, getDependentLookupStore, type DependentLists } from "@/server/ci/databricks/dependent-lookups";
import type { FormOptionsResponse } from "@/types/ci-api";

/**
 * Add/Edit form dropdown options from the connected sources only.
 *
 * Offered now (ci_lookup, in Sequential Dropdown order): Quarter, Year, Served
 * Market, Wafer Size, Process Type, Top Competitor, Product Line, Process Modules, Tool
 * Type, Currency, Order Type.
 *
 * Wafer Size is offered too: the list label maps to the stored number through the
 * approved mapping (lib/ci/wafer-size.ts), applied when a row is shown or saved.
 *
 * Fab Location and Fab Region come from the approved single-row mapping in
 * ci_lookup_dependent (Customer + Fab Location -> Fab Region). Rows with problems
 * are left out and reported in `pendingSources`; nothing is repaired or invented.
 *
 * Customer is the Customer list in ci_lookup (Lookups > Dropdown lists). Fab Location / Fab
 * Region, Product Name, Process Location and Technology Node come from ci_lookup_dependent
 * (the same mapping the Lookups screen edits). Rows with problems are left out and reported
 * in `pendingSources`; nothing is repaired or invented.
 *
 * Authorization is the same single function as Lookups and the gallery. Saving
 * is not part of this file.
 */

export const PENDING_FORM_SOURCES = [
  "Customer list: it is empty (add customers under Lookups > Dropdown lists > Customer)",
];

export interface FormOptionsDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<unknown>;
  repository(): Pick<CiRepository, "listLookups">;
  dependentLists(): Promise<DependentLists>;
}

const defaultDeps: FormOptionsDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.lookupsView),
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  repository: getCiRepository,
  dependentLists: async () => dependentListsFrom((await getDependentLookupStore()?.list()) ?? []),
};

export async function loadAvailableFormOptions(identity: SessionIdentity, deps: FormOptionsDeps = defaultDeps): Promise<FormOptionsResponse> {
  deps.requireTables();
  deps.requireConnected();
  await deps.authorize(identity);
  return safely(async () => {
    const [lookups, dep] = await Promise.all([deps.repository().listLookups(), deps.dependentLists()]);
    const customers = lookups.filter((l) => l.category === "Customer" && l.active).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.value);
    return {
      lookups,
      reference: { customers, customerFabs: dep.customerFabs, competitorProducts: dep.competitorProducts, processLocations: dep.processLocations, technologyNodes: dep.technologyNodes },
      pendingSources: [...(customers.length ? [] : PENDING_FORM_SOURCES), ...dep.issues.slice(0, 5)],
    };
  }, "loaded");
}
