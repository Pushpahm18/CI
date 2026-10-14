import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { updateUserFor } from "@/server/ci/services/management";
import type { SaveUserRequest } from "@/types/ci-api";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  return ciRoute(request, "PUT /api/user-management/[id]", REQUIRES.userAdminSave, async (user) => {
    const { id } = await context.params;
    const updated = await updateUserFor(user, id, await readJson<SaveUserRequest>(request));
    return Response.json({ user: updated });
  });
}
