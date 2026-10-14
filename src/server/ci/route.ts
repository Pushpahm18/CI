import { withWarehouseAuth } from "@/server/api/with-warehouse-auth";
import { errorResponse, ValidationError } from "@/server/ci/errors";
import { getSessionIdentity, resolveCurrentUser } from "@/server/ci/current-user";
import { requireTablesConfigured } from "@/server/ci/readiness";
import type { CiTableKey } from "@/server/db/schema";
import type { CiUser } from "@/types/ci";

/**
 * Shared CI API route wrapper: forwards the Databricks Apps user token
 * (server/api/with-warehouse-auth.ts), checks the signed-in session, then that
 * every table this route needs is configured (server/db/schema.ts — otherwise
 * "CI database table configuration is pending: <tables>", no query attempted),
 * resolves the signed-in CI user, and turns every CiError into its JSON status.
 * `requires` is mandatory so each route states the tables it depends on
 * (see REQUIRES in server/ci/readiness.ts).
 */
export function ciRoute(
  request: Request,
  context: string,
  requires: readonly CiTableKey[],
  handler: (user: CiUser) => Promise<Response>
): Promise<Response> {
  return withWarehouseAuth(request, async () => {
    try {
      const identity = await getSessionIdentity();
      requireTablesConfigured(requires);
      const user = await resolveCurrentUser(identity);
      return await handler(user);
    } catch (error) {
      return errorResponse(error, context);
    }
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ValidationError(["Request body must be JSON."]);
  }
}
