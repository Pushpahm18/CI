import { ciApiRoute } from "@/server/ci/api-route";
import { listLoginHistory } from "@/server/ci/login-history/service";

/**
 * The Login History list: every recorded sign-in, newest first. READ-ONLY.
 * Needs a signed-in session; authorization: server/ci/user-access/access.ts.
 * While the CI Login History table is not configured it answers 503 with
 * "CI database table configuration is pending: Login History" (nothing is read).
 */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/login-history", async (identity) => Response.json(await listLoginHistory(identity)));
}
