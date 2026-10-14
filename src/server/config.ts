/**
 * Databricks environment detection (server-only). Which CI tables to use lives in server/db/schema.ts;
 * this file only answers "is a SQL warehouse configured for this process?".
 *
 * Environment variables (set in .env.local locally, or the Databricks App's
 * environment / secrets when deployed — never in source):
 *   DATABRICKS_HOST                    workspace URL
 *   DATABRICKS_WAREHOUSE_ID            SQL warehouse id, or
 *   DATABRICKS_WAREHOUSE_HTTP_PATH     /sql/1.0/warehouses/<id>
 *   DATABRICKS_TOKEN                   personal/service token, or
 *   DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET   service-principal OAuth
 * Inside a Databricks App, the platform injects the client id/secret and
 * forwards each signed-in user's token (see server/db/request-auth.ts).
 */

function getOAuthClientId(): string | undefined {
  return process.env.DATABRICKS_CLIENT_ID ?? process.env.DATABRICKS_OAUTH_CLIENT_ID;
}

function getOAuthClientSecret(): string | undefined {
  return process.env.DATABRICKS_CLIENT_SECRET ?? process.env.DATABRICKS_OAUTH_CLIENT_SECRET;
}

/** True when running as a Databricks App (the platform sets these). */
export function isDatabricksAppRuntime(): boolean {
  return Boolean(process.env.DATABRICKS_APP_PORT || process.env.DATABRICKS_APP_NAME);
}

/**
 * Host + warehouse + some way to authenticate. Inside a Databricks App the
 * runtime is enough for auth: requests carry x-forwarded-access-token and
 * the app's service principal credentials are injected.
 */
export function hasWarehouseBackend(): boolean {
  const host = process.env.DATABRICKS_HOST;
  const hasWarehouse = Boolean(process.env.DATABRICKS_WAREHOUSE_HTTP_PATH || process.env.DATABRICKS_WAREHOUSE_ID);
  const hasEnvAuth = Boolean(process.env.DATABRICKS_TOKEN || (getOAuthClientId() && getOAuthClientSecret()));
  return Boolean(host && hasWarehouse && (hasEnvAuth || isDatabricksAppRuntime()));
}
