import { getForwardedUserToken, runWithWarehouseAuth } from "@/server/db/request-auth";

export function withWarehouseAuth(
  request: Request,
  handler: () => Promise<Response>
): Promise<Response> {
  return runWithWarehouseAuth({ userToken: getForwardedUserToken(request) }, handler);
}
