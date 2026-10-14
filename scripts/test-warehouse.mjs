/**
 * Databricks SQL warehouse connectivity smoke test.
 * Reads .env.local and runs `SELECT 1` through the same Statement Execution
 * API the app uses (src/server/db/warehouse.ts). It reads no table and
 * changes no data.
 *
 * Output is deliberately minimal: a result line, the HTTP status code and
 * Databricks' fixed error category (e.g. PERMISSION_DENIED). It never prints
 * the response body, Databricks' error message, the host, the warehouse id
 * or the token.
 *
 * Needs, in .env.local (never commit real values):
 *   DATABRICKS_HOST, DATABRICKS_TOKEN, and
 *   DATABRICKS_WAREHOUSE_ID or DATABRICKS_WAREHOUSE_HTTP_PATH
 * Run: node scripts/test-warehouse.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");

for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const host = (process.env.DATABRICKS_HOST ?? "").replace(/\/$/, "");
const token = process.env.DATABRICKS_TOKEN;
const warehouseId =
  process.env.DATABRICKS_WAREHOUSE_ID ??
  (process.env.DATABRICKS_WAREHOUSE_HTTP_PATH ?? "").match(/\/warehouses\/([^/?]+)/)?.[1];

if (!host || !token || !warehouseId) {
  console.error("Set DATABRICKS_HOST, DATABRICKS_TOKEN and DATABRICKS_WAREHOUSE_ID (or _HTTP_PATH) in .env.local first.");
  process.exit(1);
}

/** Databricks error codes are fixed upper-case categories; anything else is not printed. */
const safeCode = (code) => (typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "unknown");

const HINTS = {
  401: "The token was rejected (expired, revoked or mistyped).",
  403: "The token is valid but lacks permission (e.g. CAN USE on the warehouse).",
  404: "Host or warehouse not found — check DATABRICKS_HOST and the HTTP path / warehouse id.",
};

let res;
try {
  res = await fetch(`${host}/api/2.0/sql/statements/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement: "SELECT 1 AS ok",
      wait_timeout: "50s",
    }),
  });
} catch {
  console.error("Warehouse check failed: could not reach DATABRICKS_HOST (network/DNS, or the value isn't an https:// URL).");
  process.exit(1);
}

const body = await res.json().catch(() => ({}));
const state = body?.status?.state;

if (res.ok && state === "SUCCEEDED") {
  console.log("Warehouse reachable: SELECT 1 succeeded.");
} else if (res.ok && (state === "PENDING" || state === "RUNNING")) {
  console.log(`Warehouse is still starting (state ${state}). A serverless warehouse can take a little while to wake up — run this again in a minute.`);
} else {
  console.error(`Warehouse check failed: HTTP ${res.status}, state ${state ?? "n/a"}, error code ${safeCode(body?.error_code ?? body?.status?.error?.error_code)}.`);
  if (HINTS[res.status]) console.error(HINTS[res.status]);
  process.exitCode = 1;
}
