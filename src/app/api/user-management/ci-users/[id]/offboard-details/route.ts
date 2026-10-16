import { ciApiRoute } from "@/server/ci/api-route";
import { offboardDetails } from "@/server/ci/user-management/ci-users-offboard";

type RouteContext = { params: Promise<{ id: string }> };

/** Who took over from an off-boarded user (read-only, from the audit history). */
export async function GET(request: Request, context: RouteContext) {
  return ciApiRoute(request, "GET /api/user-management/ci-users/[id]/offboard-details", async (identity) => {
    const { id } = await context.params;
    return Response.json(await offboardDetails(identity, id));
  });
}
