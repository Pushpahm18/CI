import { ciRoute } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { getAuditFor } from "@/server/ci/services/competitive-info";
import type { AuditResponse } from "@/types/ci-api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  return ciRoute(request, "GET /api/competitive-info/[id]/audit", REQUIRES.competitiveInfoAudit, async (user) => {
    const { id } = await context.params;
    const body: AuditResponse = { entries: await getAuditFor(user, id) };
    return Response.json(body);
  });
}
