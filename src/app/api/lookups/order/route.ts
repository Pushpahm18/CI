import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { reorderLookupValues } from "@/server/ci/lookups/service";

/** Sequential Dropdown Lookup: saves one list's display order. */
export async function PUT(request: Request) {
  return ciApiRoute(request, "PUT /api/lookups/order", async (identity) => {
    await reorderLookupValues(identity, await readJsonBody(request));
    return new Response(null, { status: 204 });
  });
}
