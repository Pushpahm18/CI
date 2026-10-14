import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { reorderDependentEntries } from "@/server/ci/dependent-lists/write-service";

/** Saves the display order of one group of a cascading list. */
export async function PUT(request: Request) {
  return ciApiRoute(request, "PUT /api/dependent-lists/order", async (identity) => {
    await reorderDependentEntries(identity, await readJsonBody(request));
    return new Response(null, { status: 204 });
  });
}
