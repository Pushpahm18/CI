import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { removeDependentEntry, renameDependentEntry } from "@/server/ci/dependent-lists/write-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Renames a value (and, for a fab, changes its Fab Region). */
export async function PATCH(request: Request, context: RouteContext) {
  return ciApiRoute(request, "PATCH /api/dependent-lists/[id]", async (identity) => {
    const { id } = await context.params;
    await renameDependentEntry(identity, id, await readJsonBody(request));
    return new Response(null, { status: 204 });
  });
}

/** Removes a value from new dropdowns (sets it inactive). Never deletes. */
export async function DELETE(request: Request, context: RouteContext) {
  return ciApiRoute(request, "DELETE /api/dependent-lists/[id]", async (identity) => {
    const { id } = await context.params;
    await removeDependentEntry(identity, id);
    return new Response(null, { status: 204 });
  });
}
