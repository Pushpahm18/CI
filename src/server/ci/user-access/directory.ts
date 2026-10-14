import { emailFromDirectoryUser } from "@/lib/ci/identity-email";
import type { DirectoryUser } from "@/types/ci-api";

/**
 * Server-side Microsoft Entra ID (Azure AD) user-directory lookup, through
 * Microsoft Graph's app-only client-credentials flow — a read-only "load the
 * organization's users, pick one" list for User Access. Nothing here creates,
 * updates or deletes Entra users or groups. Ported from SAMBA
 * (src/server/entra-users.ts); same pattern as server/db/warehouse.ts (cached
 * token, plain fetch, Bearer header), no Azure SDK.
 *
 * Server-only: import it from API routes and services, never from a
 * "use client" file.
 *
 * Needs, on the server only (never sent to the browser):
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 * and the app registration must have Microsoft Graph's `User.Read.All`
 * APPLICATION permission with admin consent. Without them directory search
 * reports "not configured" — it never returns made-up users.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const AUTHORITY_BASE = "https://login.microsoftonline.com";

/** Graph's maximum page size for /users. */
const PAGE_SIZE = 999;
/** Guard against a looping @odata.nextLink (allows ~99,900 users). */
const MAX_PAGES = 100;
/** The full list is reused from memory for this long (never persisted or shared across processes). */
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;

/** AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are not all set — a deployment problem, not a user error. */
export class DirectoryConfigError extends Error {}

/** Any failure talking to Microsoft's token endpoint or Graph (network, non-2xx, malformed payload). */
export class DirectoryLookupError extends Error {}

export function isDirectoryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);
}

function getConfig(): { tenantId: string; clientId: string; clientSecret: string } {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new DirectoryConfigError(
      "Microsoft Entra ID directory search is not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET."
    );
  }
  return { tenantId, clientId, clientSecret };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** App-only Graph token, cached in memory and refreshed a minute before it expires. */
async function fetchGraphToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const { tenantId, clientId, clientSecret } = getConfig();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  let res: Response;
  try {
    res = await fetch(`${AUTHORITY_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch {
    // Never include the caught error: on some networks it can echo request details.
    throw new DirectoryLookupError("Unable to reach Microsoft Entra ID.");
  }
  // Status code only — the response body of a token endpoint can itself be sensitive.
  if (!res.ok) throw new DirectoryLookupError(`Failed to authenticate with Microsoft Entra ID (${res.status}).`);

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new DirectoryLookupError("Microsoft Entra ID did not return an access token.");
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

type GraphUsersPage = {
  value?: { id?: string; displayName?: string; userPrincipalName?: string; mail?: string | null }[];
  "@odata.nextLink"?: string;
};

let cachedUsers: { value: DirectoryUser[]; expiresAt: number } | null = null;

/**
 * The organization's whole directory (id, displayName, userPrincipalName and
 * mail only), following @odata.nextLink until Graph stops returning one. The picker
 * filters this list in the browser as you type, so it takes no query. A user
 * with no userPrincipalName is dropped. `email` is the address CI saves and matches at
 * sign-in: mail when present, otherwise the user principal name (lib/ci/identity-email.ts).
 */
export async function listDirectoryUsers(): Promise<DirectoryUser[]> {
  if (cachedUsers && cachedUsers.expiresAt > Date.now()) return cachedUsers.value;

  const authHeader = { Authorization: `Bearer ${await fetchGraphToken()}` };
  const results: DirectoryUser[] = [];
  let url: string | undefined = `${GRAPH_BASE}/users?${new URLSearchParams({
    $select: "id,displayName,userPrincipalName,mail",
    $top: String(PAGE_SIZE),
  }).toString()}`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: authHeader, cache: "no-store" });
    } catch {
      throw new DirectoryLookupError("Unable to reach Microsoft Graph.");
    }
    if (!res.ok) throw new DirectoryLookupError(`Microsoft Graph user list failed (${res.status}).`);

    const json = (await res.json()) as GraphUsersPage;
    for (const u of json.value ?? []) {
      if (u.id && u.userPrincipalName) {
        results.push({
          id: u.id,
          displayName: u.displayName?.trim() || u.userPrincipalName,
          userPrincipalName: u.userPrincipalName,
          mail: u.mail?.trim() ?? "",
          email: emailFromDirectoryUser(u),
        });
      }
    }
    url = json["@odata.nextLink"];
  }

  cachedUsers = { value: results, expiresAt: Date.now() + LIST_CACHE_TTL_MS };
  return results;
}
