import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { loadCiUserRecords } from "@/server/ci/user-management/ci-users";
import { createCiUser } from "@/server/ci/user-management/ci-users-write";

/** GET: ci_user_management rows as stored (read-only). POST: add one user. Both need Corporate Marketing; checked in the services. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/user-management/ci-users", async (identity) => Response.json(await loadCiUserRecords(identity)));
}

export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/user-management/ci-users", async (identity) =>
    Response.json(await createCiUser(identity, await readJsonBody(request)), { status: 201 })
  );
}
