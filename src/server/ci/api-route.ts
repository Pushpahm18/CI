import { withWarehouseAuth } from "@/server/api/with-warehouse-auth";
import { getSessionIdentity, type SessionIdentity } from "@/server/ci/current-user";
import { errorResponse, ValidationError } from "@/server/ci/errors";

/**
 * Route wrapper for the CI API routes that authorize inside their service:
 * forwards the Databricks user token, requires a signed-in session (identity from
 * Auth.js, never the request body), and turns errors into safe JSON — CiErrors keep
 * their status; anything else becomes a generic 500 with details in the
 * server log only (see errorResponse).
 */
export function ciApiRoute(
  request: Request,
  context: string,
  handler: (identity: SessionIdentity) => Promise<Response>
): Promise<Response> {
  return withWarehouseAuth(request, async () => {
    try {
      return await handler(await getSessionIdentity());
    } catch (error) {
      return errorResponse(error, context);
    }
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError(["Request body must be JSON."]);
  }
}
