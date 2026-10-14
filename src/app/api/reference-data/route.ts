import { ciRoute } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { referenceDataFor } from "@/server/ci/services/management";
import type { ReferenceDataResponse } from "@/types/ci-api";

/** BRD §7.6 Reference Data — read-only. */
export async function GET(request: Request) {
  return ciRoute(request, "GET /api/reference-data", REQUIRES.referenceData, async (user) => {
    const body: ReferenceDataResponse = await referenceDataFor(user);
    return Response.json(body);
  });
}
