import { ciApiRoute, readJsonBody } from "@/server/ci/api-route";
import { addUserAccessEntry, listUserAccess } from "@/server/ci/user-access/entries";

/** The User Access list (ci_user_access): every person added, newest first. READ-ONLY. Needs Corporate Marketing (checked in the service). */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/user-access", async (identity) => Response.json(await listUserAccess(identity)));
}

/**
 * Add ONE person (name + email from the Microsoft directory) to User Access. This writes one row to ci_user_access and an
 * audit entry; for an Account Team person that row is also what lets them sign in (Corporate Marketing is exempt).
 */
export async function POST(request: Request) {
  return ciApiRoute(request, "POST /api/user-access", async (identity) => Response.json(await addUserAccessEntry(identity, await readJsonBody(request)), { status: 201 }));
}
