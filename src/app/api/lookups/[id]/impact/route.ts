import { ciApiRoute } from "@/server/ci/api-route";
import { previewLookupRemoval } from "@/server/ci/lookups/service";
import type { LookupDeactivationImpact } from "@/types/ci-api";

type RouteContext = { params: Promise<{ id: string }> };

/** Read-only: the dependent mappings that deactivating this value would also deactivate (shown in the confirmation). */
export async function GET(request: Request, context: RouteContext) {
  return ciApiRoute(request, "GET /api/lookups/[id]/impact", async (identity) => {
    const { id } = await context.params;
    const body: LookupDeactivationImpact = await previewLookupRemoval(identity, id);
    return Response.json(body);
  });
}
