import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { addLookupValue, loadLookups } from "@/server/ci/lookups/service";

/**
 * Lookups on ci_lookup. Needs a signed-in session; authorization (Corporate
 * Marketing) and table readiness are decided in server/ci/lookups/service.ts.
 */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/lookups", async (identity) => Response.json(await loadLookups(identity)));
}

export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/lookups", async (identity) =>
    Response.json({ lookup: await addLookupValue(identity, await readJsonBody(request)) }, { status: 201 })
  );
}
