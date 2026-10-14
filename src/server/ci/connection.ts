import { DisabledError } from "@/server/ci/errors";
import { hasWarehouseBackend } from "@/server/config";

/** Every read path calls this first: no Databricks configuration → a clear "not connected" status, no query. */
export function requireConnected(): void {
  if (!hasWarehouseBackend()) {
    throw new DisabledError("Databricks is not connected on this server (connection settings are missing).");
  }
}
