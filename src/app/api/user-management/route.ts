import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { createUserFor, listUsersFor } from "@/server/ci/services/management";
import type { SaveUserRequest, UsersResponse } from "@/types/ci-api";

export async function GET(request: Request) {
  return ciRoute(request, "GET /api/user-management", REQUIRES.userAdminList, async (user) => {
    const body: UsersResponse = await listUsersFor(user);
    return Response.json(body);
  });
}

export async function POST(request: Request) {
  return ciRoute(request, "POST /api/user-management", REQUIRES.userAdminSave, async (user) => {
    const created = await createUserFor(user, await readJson<SaveUserRequest>(request));
    return Response.json({ user: created }, { status: 201 });
  });
}
