import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { resolveCiAccess, roleMayOpenPage } from "@/server/ci/access";

// next-auth v5's `auth()` middleware wrapper augments the request it hands
// to this callback with an `auth` property (the verified session, or null)
// — there's no public type export for that augmented request shape (its
// internal `NextAuthRequest` type lives under a non-exported subpath), so
// it's reproduced here the same way the official Auth.js docs' own
// middleware examples do.
type AuthenticatedRequest = NextRequest & { auth: Session | null };

const TOKEN_COOKIE = "ci_dbx_user_token";

// Reachable with NO Microsoft session at all — the login page itself and
// every NextAuth route (the OAuth redirect/callback dance has to happen
// before a session exists).
const NO_SESSION_REQUIRED = ["/login", "/api/auth"];

// Reachable with a Microsoft session but WITHOUT the CI access check
// (Phase 2) — only /access-denied itself, so the page
// that explains the denial doesn't get redirected into a loop by the very
// check that sent the visitor there. Includes NO_SESSION_REQUIRED too:
// nothing that's exempt from the session check should be blocked by the
// deeper authorization check either.
const NO_ACCESS_CHECK = [...NO_SESSION_REQUIRED, "/access-denied"];

function matchesAny(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Next.js 16 renamed the middleware.ts file convention to proxy.ts (the
// exported function must be named `proxy` or be the default export — see
// node_modules/next/dist/docs/.../proxy.md, per this project's own
// AGENTS.md instruction to check the bundled docs first). This project's
// pre-existing `middleware.ts` predated that rename AND lived at the repo
// root — but this project's `app` dir lives under `src/`, so Next 16 only
// ever looks for `src/proxy.ts` (confirmed empirically: an unconditional
// redirect placed at the repo root silently never fired; the identical file
// moved to src/ fired immediately, no other change). The Databricks-token
// cookie-forwarding logic below was therefore silently never running in
// local dev either — a pre-existing gap, not something introduced here —
// discovered only because Microsoft Login's redirect gate needed it to
// actually run. Renamed/relocated per Next's own documented codemod;
// nothing about the logic itself changed from before.
export default auth(async (request: AuthenticatedRequest) => {
  const { pathname } = request.nextUrl;

  // Phase 1: no verified Microsoft session at all -> /login, carrying where
  // the visit was headed so signing in can return the user there.
  if (!request.auth && !matchesAny(pathname, NO_SESSION_REQUIRED)) {
    const loginUrl = new URL("/login", request.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // Phase 2: a verified Microsoft session exists — but does that person have
  // an active CI User Management record (resolveCiAccess())? Next 16 runs
  // proxy.ts on the Node.js runtime by default, so a direct Databricks query
  // here needs no Edge-runtime workaround. Fails CLOSED (redirects to
  // /access-denied) if the check itself errors (e.g. the warehouse is
  // unreachable) — this is a security boundary, so an unverifiable identity
  // is treated as unauthorized rather than silently let through.
  //
  // FAILS CLOSED: a missing, empty or unconfigured CI user table means
  // "denied" - a signed-in person is never let through just because the user
  // list is not available. The same rule (and role check) is enforced again on
  // every API route; this page gate is never the only control.
  // There is NO exemption for the local development login: in development it is
  // judged by the same rule over clearly marked MOCK records (server/ci/access.ts),
  // and every API still refuses it real data.
  if (request.auth && !matchesAny(pathname, NO_ACCESS_CHECK)) {
    const email = request.auth.user?.email;
    let authorized = false;
    let roleBlocked = false;
    // Distinguish "the check ran and said no" from "the check itself
    // couldn't run" (e.g. the Databricks warehouse is unreachable/exhausted)
    // — both still fail closed to /access-denied (never silently let an
    // unverifiable identity through), but showing the SAME "ask an admin to
    // add you" message for both is actively misleading for the second case:
    // an already-authorized person hitting a down backend would be sent to
    // ask an admin to grant access they already have. `?reason=error` lets
    // the access-denied page tell these apart and say what's actually true.
    let checkErrored = false;
    try {
      const access = email ? await resolveCiAccess(email) : ({ status: "denied" } as const);
      authorized = access.status === "authorized";
      // Account Team may open Home and All Competitive Info View only (API paths authorize themselves).
      if (access.status === "authorized" && !pathname.startsWith("/api/") && !roleMayOpenPage(access.role, pathname)) {
        authorized = false;
        roleBlocked = true;
      }
    } catch (e) {
      console.error("[CI] access check failed:", e instanceof Error ? e.message : e);
      checkErrored = true;
    }
    if (!authorized) {
      const deniedUrl = new URL("/access-denied", request.nextUrl.origin);
      if (checkErrored) deniedUrl.searchParams.set("reason", "error");
      else if (roleBlocked) deniedUrl.searchParams.set("reason", "role");
      return NextResponse.redirect(deniedUrl);
    }
  }

  // Unchanged from before: forwards the Databricks Apps proxy's user OAuth
  // token (arrives as a request header) into an HTTP-only cookie that
  // server/db/request-auth.ts reads on subsequent requests — a completely
  // separate concern from the Microsoft-login session above.
  const token = request.headers.get("x-forwarded-access-token");
  const response = NextResponse.next();
  if (token) {
    response.cookies.set(TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 55,
    });
  }
  return response;
});

// Reported bug: the ASM logo rendered as a broken image everywhere,
// including /login and /access-denied (neither requires a session at all)
// — so it wasn't an auth-state problem. Root cause: next/image's built-in
// optimizer resolves a local ("/"-rooted) src by making its OWN internal
// HTTP request back to this same server for the raw file (confirmed via a
// direct curl of /_next/image?url=%2Fasm-logo-white.png..., which came back
// "The requested resource isn't a valid image" — the optimizer's own error
// for a non-image response body). That internal request carries none of the
// browser's cookies, and the matcher below excluded /_next/image itself
// (the optimizer route) but NOT the literal asset paths it then fetches —
// so every one of those internal fetches got caught by Phase 1 above and
// redirected to /login, and the optimizer choked on the HTML redirect body
// it got back instead of PNG bytes. Excluding the real public logo files
// here (same fix as the pre-existing _next/static/_next/image/favicon.ico
// exclusions, just extended to these) lets the optimizer's self-fetch reach
// them directly.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|asm-logo-white.png|asm-logo.png|asm-mark-white.png).*)",
  ],
};
