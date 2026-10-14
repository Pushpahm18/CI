import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { createRecordFor, listRecordsFor } from "@/server/ci/services/competitive-info";
import type { RecordsResponse, SaveRecordRequest, SaveRecordResponse } from "@/types/ci-api";

export async function GET(request: Request) {
  return ciRoute(request, "GET /api/competitive-info", REQUIRES.competitiveInfoList, async (user) => {
    const body: RecordsResponse = { records: await listRecordsFor(user) };
    return Response.json(body);
  });
}

export async function POST(request: Request) {
  return ciRoute(request, "POST /api/competitive-info", REQUIRES.competitiveInfoSave, async (user) => {
    const body: SaveRecordResponse = await createRecordFor(user, await readJson<SaveRecordRequest>(request));
    return Response.json(body, { status: 201 });
  });
}
