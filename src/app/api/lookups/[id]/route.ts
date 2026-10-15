import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { removeLookupValue, renameLookupValue } from "@/server/ci/lookups/service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Removes a value from new dropdowns (sets it inactive); rows already using it keep it (CI Prototype). Never deletes.
 * Customer, Served Market, Top Competitor and Fab Region also deactivate their dependent mappings and need ?confirmImpact=<fingerprint>
 * (the fingerprint from the impact the person reviewed; 409 without it, or if the mappings changed since); GET /api/lookups/[id]/impact lists what the confirmation shows.
 */
export async function DELETE(request: Request, context: RouteContext) {
  return ciApiRoute(request, "DELETE /api/lookups/[id]", async (identity) => {
    const { id } = await context.params;
    await removeLookupValue(identity, id, undefined, { confirmedImpact: new URL(request.url).searchParams.get("confirmImpact") ?? undefined });
    return new Response(null, { status: 204 });
  });
}

/** Renames a value in its list; rows already using the old text keep it. */
export async function PATCH(request: Request, context: RouteContext) {
  return ciApiRoute(request, "PATCH /api/lookups/[id]", async (identity) => {
    const { id } = await context.params;
    await renameLookupValue(identity, id, await readJsonBody(request));
    return new Response(null, { status: 204 });
  });
}
