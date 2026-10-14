import { readJsonBody, ciApiRoute } from "@/server/ci/api-route";
import { addDependentEntries } from "@/server/ci/dependent-lists/write-service";

/** Adds many cascading-list values with one write (Excel import); each row is validated like a single add. */
export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/dependent-lists/bulk", async (identity) => Response.json(await addDependentEntries(identity, await readJsonBody(request))));
}
