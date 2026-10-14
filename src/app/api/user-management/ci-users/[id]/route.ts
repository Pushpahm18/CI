import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { deactivateCiUser, updateCiUser } from "@/server/ci/user-management/ci-users-write";

type RouteContext = { params: Promise<{ id: string }> };

/** Edit a user's name, role and scope. The email and id never change. */
export async function PUT(request: Request, context: RouteContext) {
  return ciApiRoute(request, "PUT /api/user-management/ci-users/[id]", async (identity) => {
    const { id } = await context.params;
    return Response.json(await updateCiUser(identity, id, await readJsonBody(request)));
  });
}

/** "Delete" = deactivate (is_active = false, status = Off-boarded). No row is ever removed. */
export async function DELETE(request: Request, context: RouteContext) {
  return ciApiRoute(request, "DELETE /api/user-management/ci-users/[id]", async (identity) => {
    const { id } = await context.params;
    return Response.json(await deactivateCiUser(identity, id));
  });
}
