import { ciApiRoute } from "@/server/ci/api-route";
import { loadHome } from "@/server/ci/home/service";

/** Home: counts and most recent rows of the signed-in person's view of ci_main. Read-only; scope applied on the server. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/home", async (identity) => Response.json(await loadHome(identity)));
}
