import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DEV_MOCK_PROVIDER_ID, devMockProvider, isDevMockAuthEnabled } from "@/server/dev-auth";
import { recordLoginEvent } from "@/server/ci/login-history/capture";
import { emailFromSignInClaims } from "@/lib/ci/identity-email";

// Microsoft Login (Entra ID). The CI access check — does this person have an
// active CI User Management record? — runs in src/proxy.ts. This file runs
// the user-delegated (authorization-code) flow that authenticates the
// person opening CI, using the Entra App Registration
// (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET).
//
// JWT session strategy (the Auth.js default when no database adapter is
// configured) — no new Databricks table, no Prisma/DB adapter added for
// this — no Databricks table is needed for the login session. The session itself lives in a signed, encrypted, HTTP-only
// cookie; nothing here is readable or writable from client-side JS.
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  trustHost: true,
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
      // Default provider config additionally fetches the user's profile
      // photo via a second Graph call (see @auth/core's built-in profile()) —
      // skipped here: Phase 1 only needs identity (email/UPN, display name,
      // Entra object id), not a photo, so this stays a single token exchange.
      async profile(profile) {
        return {
          // `oid` (the Entra object id) is Microsoft's own documented,
          // stable, unique-per-tenant identifier for a user account — never
          // `sub`, which the same profile()'s own doc comment notes is a
          // pairwise (per-app) value, not a durable user id. `sub` is kept
          // as a fallback only for the rare case `oid` isn't present.
          id: profile.oid ?? profile.sub,
          name: profile.name,
          // The primary matching identity per the CR: organization
          // email/UPN, never display name. `email` isn't always populated
          // for every tenant/account configuration (see the provider's own
          // doc comment on the `email` claim) — `preferred_username` (the
          // UPN) is the documented fallback identifier for exactly this
          // case, so it's used here rather than leaving identity blank.
          // Same precedence as the directory flow (lib/ci/identity-email.ts): mail first, UPN as the fallback.
          email: emailFromSignInClaims(profile) || undefined,
        };
      },
    }),
    // Local UI development only — see server/dev-auth.ts. Never registered
    // outside `next dev` + DEV_MOCK_AUTH=true.
    ...(isDevMockAuthEnabled() ? [devMockProvider()] : []),
  ],
  pages: {
    // The branded login screen instead of Auth.js's own default page —
    // see app/login/page.tsx.
    signIn: "/login",
  },
  events: {
    // Login History (server/ci/login-history). `signIn` fires once per completed
    // sign-in — not on every session refresh — which is "record when someone
    // signs in", not "record every request". Never awaited: it must not delay
    // or block the sign-in, and recordLoginEvent() catches its own errors. Only
    // successful sign-ins are recorded (no sign-outs, no failures). The local
    // development login is not a real sign-in, so it is never recorded.
    async signIn({ user, account }) {
      if (account?.provider === DEV_MOCK_PROVIDER_ID) return;
      void recordLoginEvent(user.email ?? "", user.name ?? "");
    },
  },
});
