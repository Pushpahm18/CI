import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { offboardPreviewFor, offboardUserFor } from "@/server/ci/services/management";
import type { OffboardPreviewResponse, OffboardRequest, OffboardResponse } from "@/types/ci-api";

type RouteContext = { params: Promise<{ id: string }> };

/** How many rows the leaver owns (BRD §5.5 alert). */
export async function GET(request: Request, context: RouteContext) {
  return ciRoute(request, "GET /api/user-management/[id]/offboard", REQUIRES.userAdminOffboardPreview, async (user) => {
    const { id } = await context.params;
    const body: OffboardPreviewResponse = { ownedRows: await offboardPreviewFor(user, id) };
    return Response.json(body);
  });
}

export async function POST(request: Request, context: RouteContext) {
  return ciRoute(request, "POST /api/user-management/[id]/offboard", REQUIRES.userAdminOffboard, async (user) => {
    const { id } = await context.params;
    const { reassignToUserId } = await readJson<OffboardRequest>(request);
    const body: OffboardResponse = { reassignedRows: await offboardUserFor(user, id, reassignToUserId) };
    return Response.json(body);
  });
}
