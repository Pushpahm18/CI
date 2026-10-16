import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { offboardCiUser, previewOffboard } from "@/server/ci/user-management/ci-users-offboard";

type RouteContext = { params: Promise<{ id: string }> };

/** The off-board alert: how many rows the user created (ci_main.created_by), or why they cannot be off-boarded. */
export async function GET(request: Request, context: RouteContext) {
  return ciApiRoute(request, "GET /api/user-management/ci-users/[id]/offboard", async (identity) => {
    const { id } = await context.params;
    return Response.json(await previewOffboard(identity, id));
  });
}

/** Off-board: audit the reassigned rows, combine Account Team scope, mark the user Off-boarded. */
export async function POST(request: Request, context: RouteContext) {
  return ciApiRoute(request, "POST /api/user-management/ci-users/[id]/offboard", async (identity) => {
    const { id } = await context.params;
    return Response.json(await offboardCiUser(identity, id, await readJsonBody(request)));
  });
}
