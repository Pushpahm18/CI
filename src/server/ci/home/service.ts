import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError, NotConfiguredError } from "@/server/ci/errors";
import { authorizeCiUser, type CiGrant } from "@/server/ci/authorization/ci-access";
import { rowInAccountScope } from "@/server/ci/authorization/scope";
import { buildHomeRecentStatement, buildHomeStatsStatement, rowToHomeRecent, rowToHomeStats } from "@/server/ci/home/data";
import { requireConnected } from "@/server/ci/connection";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { COMPETITIVE_GALLERY_LABEL, COMPETITIVE_GALLERY_SOURCE, MAIN_SCOPE_COLUMNS, tableName, type TableRef } from "@/server/db/schema";
import type { ScopeColumns } from "@/server/ci/competitive-gallery/data";
import type { HomeResponse } from "@/types/ci-api";

/**
 * Home: the numbers and the most recent rows of the signed-in person's view of corp_marketing_dev.ci.ci_main.
 * Read-only. Order: table configured -> Databricks connected -> the person is authorized (Corporate Marketing or
 * Account Team; anyone else is refused) -> two small queries run together. The scope of an Account Team user is applied in
 * the SQL WHERE clause (the same predicates as the gallery), and the few rows listed are checked against it again.
 */

export interface HomeDeps {
  source(): TableRef | null;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<Pick<CiGrant, "role" | "scope">>;
  scopeColumns(): ScopeColumns;
  query(statement: string): Promise<Record<string, unknown>[]>;
}

const defaultDeps: HomeDeps = {
  source: () => COMPETITIVE_GALLERY_SOURCE,
  requireConnected,
  authorize: (identity) => authorizeCiUser(identity),
  scopeColumns: () => MAIN_SCOPE_COLUMNS,
  query: (statement) => executeReadOnlyQuery(statement),
};

export async function loadHome(identity: SessionIdentity, deps: HomeDeps = defaultDeps): Promise<HomeResponse> {
  const ref = deps.source();
  if (!ref) throw new NotConfiguredError([COMPETITIVE_GALLERY_LABEL]);
  const table = tableName(ref);
  deps.requireConnected();
  const grant = await deps.authorize(identity);
  const sc = deps.scopeColumns();
  const filter = grant.scope ? { columns: sc, scope: grant.scope } : undefined;
  try {
    const [stats, recent] = await Promise.all([deps.query(buildHomeStatsStatement(table, filter)), deps.query(buildHomeRecentStatement(table, filter))]);
    const visible = recent.map(rowToHomeRecent).filter((r) => !grant.scope || rowInAccountScope(grant.scope, { customer: r.customer, segment: r.servedMarket, region: r.region }));
    return { ...rowToHomeStats(stats[0]), recent: visible.map(({ region, ...rest }) => (void region, rest)) };
  } catch (error) {
    if (error instanceof CiError) throw error;
    // The Databricks message goes to the server log only; the browser gets a safe sentence.
    console.error("[CI] home: reading from Databricks failed:", error instanceof Error ? error.message : error);
    throw new CiError("The Competitive Info table could not be read from Databricks. Check the server log for details.", 502, "INTERNAL");
  }
}
