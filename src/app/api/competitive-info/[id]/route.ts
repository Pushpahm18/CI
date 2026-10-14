import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { getRecordFor, updateRecordFor } from "@/server/ci/services/competitive-info";
import type { RecordDetailResponse, SaveRecordRequest, SaveRecordResponse } from "@/types/ci-api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  return ciRoute(request, "GET /api/competitive-info/[id]", REQUIRES.competitiveInfoRecord, async (user) => {
    const { id } = await context.params;
    const body: RecordDetailResponse = await getRecordFor(user, id);
    return Response.json(body);
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return ciRoute(request, "PUT /api/competitive-info/[id]", REQUIRES.competitiveInfoSave, async (user) => {
    const { id } = await context.params;
    const body: SaveRecordResponse = await updateRecordFor(user, id, await readJson<SaveRecordRequest>(request));
    return Response.json(body);
  });
}
