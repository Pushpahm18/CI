import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { addLookupValues } from "@/server/ci/lookups/service";

/** Adds many dropdown values with one write (Excel import); each row is validated like a single add. */
export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/lookups/bulk", async (identity) => Response.json(await addLookupValues(identity, await readJsonBody(request))));
}
