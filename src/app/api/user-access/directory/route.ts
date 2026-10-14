import { ciApiRoute } from "@/server/ci/api-route";
import { listDirectory } from "@/server/ci/user-access/service";

/**
 * The Microsoft Entra ID directory the User Access picker searches (id, name,
 * user principal name only). READ-ONLY and never touches Databricks. Reports
 * `configured: false` when the Entra settings are missing on the server.
 */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/user-access/directory", async (identity) => Response.json(await listDirectory(identity)));
}
