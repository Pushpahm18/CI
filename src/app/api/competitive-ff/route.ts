import { ciApiRoute } from "@/server/ci/api-route";
import { loadFlatFile } from "@/server/ci/competitive-ff/service";

/**
 * BRD §7.4: Competitive FF - every live row of ci_main, Corporate Marketing only. Read-only.
 * `?for=import` returns the rows in the form's own model, for the Excel import's "Download existing rows".
 */
export async function GET(request: Request) {
  const shape = new URL(request.url).searchParams.get("for") === "import" ? "import" : "display";
  return ciApiRoute(request, "GET /api/competitive-ff", async (identity) => Response.json(await loadFlatFile(identity, undefined, shape)));
}
