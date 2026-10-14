import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { loadDependentLists } from "@/server/ci/dependent-lists/service";
import { addDependentEntry } from "@/server/ci/dependent-lists/write-service";

/** Cascading lists from ci_lookup_dependent, for Lookups and Sequential Dropdown. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/dependent-lists", async (identity) => Response.json(await loadDependentLists(identity)));
}

/** Adds one value under its parent(s). */
export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/dependent-lists", async (identity) => {
    const created = await addDependentEntry(identity, await readJsonBody(request));
    return Response.json(created, { status: 201 });
  });
}
