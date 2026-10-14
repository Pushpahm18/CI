import { getRequestUserToken } from "@/server/db/request-auth";
import { assertCiWriteStatement } from "@/server/db/write-guard";

/**
 * Server-only Databricks SQL client. There is no default host or warehouse:
 * both must come from the environment.
 *
 * Runs SQL through the Databricks SQL Statement Execution REST API:
 *   POST {DATABRICKS_HOST}/api/2.0/sql/statements  { warehouse_id, statement }
 * then polls until the statement finishes and follows result chunks.
 *
 * Token, in order of preference (see executeQuery()):
 *   1. the signed-in user's token forwarded by Databricks Apps
 *      (x-forwarded-access-token -> request-auth.ts), falling back to the
 *      app identity if that user lacks table permissions;
 *   2. DATABRICKS_TOKEN;
 *   3. service-principal OAuth (DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET),
 *      cached until shortly before it expires.
 * Rows come back as plain objects keyed by column name; converting values to
 * application types is the mapper's job (server/db/row-values.ts). SQL text
 * is built with server/db/sql.ts. Never import this from client code.
 */

type StatementStatus = {
  state: string;
  error?: { message?: string };
};

type StatementResult = {
  data_array?: unknown[][];
  next_chunk_internal_link?: string;
};

type StatementResponse = {
  statement_id?: string;
  status: StatementStatus;
  manifest?: {
    schema?: { columns?: { name: string }[] };
    total_row_count?: number;
  };
  result?: StatementResult;
};

function getHost(): string {
  return (process.env.DATABRICKS_HOST ?? "").replace(/\/$/, "");
}

function getOAuthClientId(): string | undefined {
  return process.env.DATABRICKS_CLIENT_ID ?? process.env.DATABRICKS_OAUTH_CLIENT_ID;
}

function getOAuthClientSecret(): string | undefined {
  return process.env.DATABRICKS_CLIENT_SECRET ?? process.env.DATABRICKS_OAUTH_CLIENT_SECRET;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function fetchOAuthToken(): Promise<string> {
  const clientId = getOAuthClientId();
  const clientSecret = getOAuthClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set DATABRICKS_TOKEN or DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET for warehouse access"
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const host = getHost();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "all-apis",
  });

  const res = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function resolveToken(preferApp = false): Promise<string> {
  if (!preferApp) {
    const userToken = getRequestUserToken();
    if (userToken) return userToken;
  }
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  return fetchOAuthToken();
}

async function executeQueryWithToken<T extends Record<string, unknown>>(
  statement: string,
  token: string
): Promise<T[]> {
  const host = getHost();
  const warehouseId = getWarehouseId();
  if (!host || !warehouseId) {
    throw new Error("Set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID (or DATABRICKS_WAREHOUSE_HTTP_PATH) for warehouse access");
  }

  const res = await fetch(`${host}/api/2.0/sql/statements/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement,
      wait_timeout: "50s",
      on_wait_timeout: "CONTINUE",
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL execute failed (${res.status}): ${text}`);
  }

  let body = (await res.json()) as StatementResponse;
  const state = body.status?.state;
  if (state === "PENDING" || state === "RUNNING") {
    if (!body.statement_id) throw new Error("Statement missing id while running");
    body = await pollStatement(body.statement_id, token);
  }
  if (body.status?.state !== "SUCCEEDED") {
    throw new Error(body.status.error?.message ?? "SQL statement did not succeed");
  }

  const columns = body.manifest?.schema?.columns ?? [];
  // The Statement Execution API returns only the FIRST chunk inline; a large
  // result (by byte size, not row count) carries `next_chunk_internal_link`.
  // Walking that link until it's absent collects the complete result —
  // without it, big queries are silently truncated (e.g. a lookups download
  // returned 430 of 1447 rows). A result that fits in one
  // chunk has no link, so this loop is a no-op for it.
  let rows: unknown[][] = body.result?.data_array ?? [];
  let nextChunkLink = body.result?.next_chunk_internal_link;
  while (nextChunkLink) {
    const chunkRes = await fetch(`${host}${nextChunkLink}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!chunkRes.ok) {
      const text = await chunkRes.text();
      throw new Error(`SQL chunk fetch failed (${chunkRes.status}): ${text}`);
    }
    const chunk = (await chunkRes.json()) as StatementResult;
    rows = rows.concat(chunk.data_array ?? []);
    nextChunkLink = chunk.next_chunk_internal_link;
  }
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col.name] = row[idx];
    });
    return obj as T;
  });
}

export function hasWarehouseConfig(): boolean {
  return Boolean(
    getHost() &&
      getWarehouseId() &&
      (process.env.DATABRICKS_TOKEN || (getOAuthClientId() && getOAuthClientSecret()))
  );
}

export function getWarehouseId(): string {
  const id = process.env.DATABRICKS_WAREHOUSE_ID;
  if (id) return id;
  const path = process.env.DATABRICKS_WAREHOUSE_HTTP_PATH ?? "";
  const match = path.match(/\/warehouses\/([^/?]+)/);
  // No default: a missing warehouse must fail, never silently use another workspace's.
  return match?.[1] ?? "";
}

async function pollStatement(statementId: string, token: string): Promise<StatementResponse> {
  const host = getHost();
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${host}/api/2.0/sql/statements/${statementId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Statement poll failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as StatementResponse;
    const state = body.status?.state;
    if (state === "SUCCEEDED") return body;
    if (state === "FAILED" || state === "CANCELED") {
      throw new Error(body.status.error?.message ?? `Statement ${state}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Statement timed out waiting for warehouse");
}

function isUserTokenPermissionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("insufficient_permissions") ||
    m.includes("insufficient privileges") ||
    m.includes("permission denied") ||
    m.includes("access denied") ||
    m.includes("does not have") ||
    m.includes("sqlstate: 42501") ||
    m.includes("42501") ||
    (m.includes("(403)") && m.includes("sql"))
  );
}

export async function executeQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  statement: string
): Promise<T[]> {
  const userToken = getRequestUserToken();
  if (userToken) {
    try {
      return await executeQueryWithToken<T>(statement, userToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Deployed Apps forward the browser user token. That user may have warehouse
      // Can Use but no UC grants. Fall back to the app service principal OAuth
      // (DATABRICKS_CLIENT_ID/SECRET), which holds the app's table grants.
      if (isUserTokenPermissionError(message)) {
        return executeQueryWithToken<T>(statement, await resolveToken(true));
      }
      throw error;
    }
  }

  return executeQueryWithToken<T>(statement, await resolveToken(true));
}

export async function executeStatement(statement: string): Promise<void> {
  assertCiWriteStatement(statement); // CI writes only to corp_marketing_dev.ci; never to SAMBA
  await executeQuery(statement);
}

export async function pingWarehouse(): Promise<{ ok: boolean; error?: string }> {
  try {
    await executeQuery("SELECT 1 AS ok");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "warehouse ping failed",
    };
  }
}
