import { withWarehouseAuth } from "@/server/api/with-warehouse-auth";
import { getAuthDiagnostics } from "@/server/db/request-auth";
import { hasWarehouseConfig, pingWarehouse } from "@/server/db/warehouse";
import { pendingRequiredTables } from "@/server/ci/readiness";

/**
 * Deployment health check: is the SQL warehouse reachable, and are the CI
 * tables configured yet? When the warehouse is configured, each call runs
 * `SELECT 1` (no table is read).
 *
 * The response carries only fixed status words — never Databricks' own error
 * text, host, warehouse id or any credential. The underlying reason for a
 * failure is written to the server log only.
 */
export async function GET(request: Request) {
  return withWarehouseAuth(request, async () => {
    const auth = getAuthDiagnostics(request);
    // Names of the CI tables still waiting for configuration (server/db/schema.ts) — labels only.
    const pendingCiTables = pendingRequiredTables();
    let warehouse: "connected" | "unavailable" | "not-configured" = "not-configured";
    if (hasWarehouseConfig()) {
      const ping = await pingWarehouse();
      warehouse = ping.ok ? "connected" : "unavailable";
      if (!ping.ok) console.error("[CI] health: warehouse check failed:", ping.error);
    }
    const ok = warehouse !== "unavailable";
    return Response.json(
      {
        status: ok ? "ok" : "degraded",
        warehouse,
        ...(warehouse === "unavailable" ? { message: "The data warehouse could not be reached. Check the server log for details." } : {}),
        ciTablesConfigured: pendingCiTables.length === 0,
        pendingCiTables,
        auth,
        timestamp: new Date().toISOString(),
      },
      { status: ok ? 200 : 503 }
    );
  });
}
