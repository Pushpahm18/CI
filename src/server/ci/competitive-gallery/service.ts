import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError, ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import { GALLERY_ROW_LIMIT, buildDescribeStatement, buildSelectStatement, newestFirstOrder, parseDescribe, toGalleryRow, type ScopeColumns } from "@/server/ci/competitive-gallery/data";
import { MAIN_COLUMNS } from "@/server/db/main-columns";
import { authorizeCiUser, type CiGrant } from "@/server/ci/authorization/ci-access";
import { rowInAccountScope } from "@/server/ci/authorization/scope";
import { requireConnected } from "@/server/ci/connection";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { COMPETITIVE_GALLERY_LABEL, COMPETITIVE_GALLERY_SOURCE, MAIN_SCOPE_COLUMNS, tableName, type TableRef } from "@/server/db/schema";
import type { GalleryResponse } from "@/types/ci-api";

/**
 * The All Competitive Info gallery's data. Read-only, schema-driven: the
 * columns come from DESCRIBE on the configured table, the rows from
 * SELECT * — nothing here knows a column name.
 *
 * Order: table configured (else "configuration is pending", nothing attempted)
 * → Databricks connected → caller authorized → read.
 *
 * Authorization is the CI authorizer (authorization/ci-access.ts): Corporate
 * Marketing sees every row; Account Team sees only rows whose Customer AND
 * Segment AND Region are all in their validated scope. The scope is applied in
 * the SQL WHERE clause and checked again on every returned row. If the scope
 * columns are missing from the table, or a returned row cannot be checked, the
 * request is refused rather than served unfiltered.
 */

export interface GalleryServiceDeps {
  source(): TableRef | null;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<Pick<CiGrant, "role" | "scope">>;
  scopeColumns(): ScopeColumns;
  query(statement: string): Promise<Record<string, unknown>[]>;
}

const defaultDeps: GalleryServiceDeps = {
  source: () => COMPETITIVE_GALLERY_SOURCE,
  requireConnected,
  authorize: (identity) => authorizeCiUser(identity),
  scopeColumns: () => MAIN_SCOPE_COLUMNS,
  query: (statement) => executeReadOnlyQuery(statement),
};

export async function loadGallery(identity: SessionIdentity, deps: GalleryServiceDeps = defaultDeps): Promise<GalleryResponse> {
  const ref = deps.source();
  if (!ref) throw new NotConfiguredError([COMPETITIVE_GALLERY_LABEL]);
  const table = tableName(ref);
  deps.requireConnected();
  const grant = await deps.authorize(identity);
  try {
    const columns = parseDescribe(await deps.query(buildDescribeStatement(table)));
    if (columns.length === 0) {
      throw new CiError("The configured table reports no columns. Check that it exists and that this server can read it.", 502, "INTERNAL");
    }
    const scope = grant.scope;
    const sc = deps.scopeColumns();
    const needed = scope
      ? [scope.customers === "All" ? null : sc.customer, scope.segments === "All" ? null : sc.segment, scope.regions === "All" ? null : sc.region].filter((c): c is string => c !== null)
      : [];
    if (scope && !needed.every((c) => columns.some((col) => col.name === c))) {
      throw new ForbiddenError("Your scope cannot be applied to this table, so no rows are shown.");
    }
    // Newest first, so the 5000-row limit keeps the most recent rows and the grid opens with them on top.
    const canOrder = [MAIN_COLUMNS.modifiedOn, MAIN_COLUMNS.createdOn, MAIN_COLUMNS.recordId].every((n) => columns.some((c) => c.name === n));
    const order = canOrder ? newestFirstOrder(MAIN_COLUMNS) : undefined;
    const raw = await deps.query(buildSelectStatement(table, GALLERY_ROW_LIMIT, scope ? { columns: sc, scope } : undefined, order));
    const truncated = raw.length > GALLERY_ROW_LIMIT;
    const visible = scope
      ? raw.filter((r) => rowInAccountScope(scope, { customer: String(r[sc.customer] ?? ""), segment: String(r[sc.segment] ?? ""), region: String(r[sc.region] ?? "") }))
      : raw;
    return {
      table,
      columns,
      rows: visible.slice(0, GALLERY_ROW_LIMIT).map((r) => toGalleryRow(r, columns)),
      truncated,
      rowLimit: GALLERY_ROW_LIMIT,
    };
  } catch (error) {
    if (error instanceof CiError) throw error;
    // The Databricks message goes to the server log only; the browser gets a safe sentence.
    console.error("[CI] competitive gallery: reading from Databricks failed:", error instanceof Error ? error.message : error);
    throw new CiError("The Competitive Info table could not be read from Databricks. Check the server log for details.", 502, "INTERNAL");
  }
}
