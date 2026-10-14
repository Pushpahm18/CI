import { AsyncLocalStorage } from "async_hooks";

const TOKEN_COOKIE = "ci_dbx_user_token";

type WarehouseAuth = { userToken?: string };

const warehouseAuthStore = new AsyncLocalStorage<WarehouseAuth>();

function tokenFromCookieHeader(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === TOKEN_COOKIE && rest.length > 0) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

export function getForwardedUserToken(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-access-token") ??
    tokenFromCookieHeader(request.headers.get("cookie"))
  );
}

export function runWithWarehouseAuth<T>(auth: WarehouseAuth, fn: () => Promise<T>): Promise<T> {
  return warehouseAuthStore.run(auth, fn);
}

export function getRequestUserToken(): string | undefined {
  return warehouseAuthStore.getStore()?.userToken;
}

export function getAuthDiagnostics(request: Request) {
  const headerToken = request.headers.get("x-forwarded-access-token");
  const cookieToken = tokenFromCookieHeader(request.headers.get("cookie"));
  return {
    hasHeaderToken: Boolean(headerToken),
    hasCookieToken: Boolean(cookieToken),
    authSource: headerToken ? "header" : cookieToken ? "cookie" : "none",
  };
}
