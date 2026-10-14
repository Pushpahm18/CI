import { ciApiRoute } from "@/server/ci/api-route";
import { loadFlatFile } from "@/server/ci/competitive-ff/service";

/** BRD §7.4: Competitive FF - every live row of ci_main, Corporate Marketing only. Read-only. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/competitive-ff", async (identity) => Response.json(await loadFlatFile(identity)));
}
