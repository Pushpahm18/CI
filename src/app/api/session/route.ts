import { withWarehouseAuth } from "@/server/api/with-warehouse-auth";
import { getSessionIdentity } from "@/server/ci/current-user";
import { resolveCiAccess } from "@/server/ci/access";
import { errorResponse } from "@/server/ci/errors";
import type { SessionResponse } from "@/types/ci-api";

/**
 * The signed-in identity plus their CI role and scope, taken from
 * ci_user_management by the same fail-closed rule as the page gate (a person
 * without a valid record gets user: null). This only drives what the UI shows;
 * every API route authorizes again on its own.
 */
export async function GET(request: Request) {
  return withWarehouseAuth(request, async () => {
    try {
      const identity = await getSessionIdentity();
      const body: SessionResponse = { ...identity, dataStatus: "connected", user: null };
      try {
        const access = await resolveCiAccess(identity.email);
        body.user = access.status === "authorized" ? access.user : null;
      } catch (error) {
        console.error("[CI] session user lookup failed:", error instanceof Error ? error.message : error);
        body.dataStatus = "error";
      }
      return Response.json(body);
    } catch (error) {
      return errorResponse(error, "GET /api/session");
    }
  });
}
