import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError, NotConfiguredError } from "@/server/ci/errors";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { requireConnected } from "@/server/ci/connection";
import { FLAT_FILE_ROW_LIMIT, buildFlatFileStatement, rowToFlatDisplayRecord, rowToFlatRecord } from "@/server/ci/competitive-ff/data";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { COMPETITIVE_GALLERY_LABEL, COMPETITIVE_GALLERY_SOURCE, tableName, type TableRef } from "@/server/db/schema";
import type { RecordsResponse } from "@/types/ci-api";

/**
 * Competitive FF (BRD §7.4): every live row of corp_marketing_dev.ci.ci_main, for Corporate Marketing only.
 * Read-only. Order: table configured (else "configuration is pending") -> Databricks connected -> Corporate
 * Marketing (checked at the same time as the read, but decisive: a refusal is thrown first and the rows are
 * discarded) -> the rows. Account Team never reaches this: the same check refuses them.
 */

export interface FlatFileDeps {
  source(): TableRef | null;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<unknown>;
  query(statement: string): Promise<Record<string, unknown>[]>;
}

const defaultDeps: FlatFileDeps = {
  source: () => COMPETITIVE_GALLERY_SOURCE,
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  query: (statement) => executeReadOnlyQuery(statement),
};

/**
 * "display" (the Competitive FF grid): every value as stored. "import" (the Excel import's Download existing rows): the form's own
 * model - the approved wafer-size label, numbers as numbers - so the file can be edited and imported back.
 */
export type FlatFileShape = "display" | "import";

export async function loadFlatFile(identity: SessionIdentity, deps: FlatFileDeps = defaultDeps, shape: FlatFileShape = "display"): Promise<RecordsResponse> {
  const toRecord = shape === "import" ? rowToFlatRecord : rowToFlatDisplayRecord;
  const ref = deps.source();
  if (!ref) throw new NotConfiguredError([COMPETITIVE_GALLERY_LABEL]);
  const table = tableName(ref);
  deps.requireConnected();
  try {
    const [, raw] = await authorizedReads(
      () => deps.authorize(identity),
      () => deps.query(buildFlatFileStatement(table))
    );
    return { records: raw.slice(0, FLAT_FILE_ROW_LIMIT).map(toRecord), truncated: raw.length > FLAT_FILE_ROW_LIMIT, rowLimit: FLAT_FILE_ROW_LIMIT };
  } catch (error) {
    if (error instanceof CiError) throw error;
    // The Databricks message goes to the server log only; the browser gets a safe sentence.
    console.error("[CI] competitive FF: reading from Databricks failed:", error instanceof Error ? error.message : error);
    throw new CiError("The Competitive Info table could not be read from Databricks. Check the server log for details.", 502, "INTERNAL");
  }
}
