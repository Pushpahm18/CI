import { ciApiRoute } from "@/server/ci/api-route";
import { loadAvailableFormOptions } from "@/server/ci/form-options/service";

/**
 * Add/Edit form dropdowns from the connected sources (ci_lookup). Sources that are
 * not approved yet are named in `pendingSources`, never filled with sample values.
 */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/competitive-info/form-options", async (identity) => Response.json(await loadAvailableFormOptions(identity)));
}
