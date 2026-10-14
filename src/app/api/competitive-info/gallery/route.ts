import { ciApiRoute } from "@/server/ci/api-route";
import { loadGallery } from "@/server/ci/competitive-gallery/service";

/** GET /api/competitive-info/gallery — the configured table's real columns and rows. Read-only. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/competitive-info/gallery", async (identity) => Response.json(await loadGallery(identity)));
}
