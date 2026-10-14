import { ciApiRoute } from "@/server/ci/api-route";
import { reactivateCiUser } from "@/server/ci/user-management/ci-users-write";

type RouteContext = { params: Promise<{ id: string }> };

/** Makes a deactivated user active again (CI keeps one record per email, so people are reactivated, not re-added). */
export async function POST(request: Request, context: RouteContext) {
  return ciApiRoute(request, "POST /api/user-management/ci-users/[id]/reactivate", async (identity) => {
    const { id } = await context.params;
    return Response.json(await reactivateCiUser(identity, id));
  });
}
