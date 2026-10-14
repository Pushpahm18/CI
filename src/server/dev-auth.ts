import Credentials from "next-auth/providers/credentials";

// LOCAL UI DEVELOPMENT ONLY — lets the existing "Sign in with Microsoft"
// button get a developer into the app before this project's own Microsoft
// Entra ID App Registration (AZURE_TENANT_ID/AZURE_CLIENT_ID/
// AZURE_CLIENT_SECRET) exists. Nothing here replaces or alters the real
// Entra provider in auth.ts; it only adds a second, local-only provider.
//
// Enabled ONLY when BOTH hold:
//   1. NODE_ENV === "development" — set by `next dev` itself; `next build` /
//      `npm run start` / the Databricks App (app.yaml) always run as
//      "production", so this can never switch on in a deployed build, even
//      if the flag below were accidentally set there.
//   2. DEV_MOCK_AUTH === "true" — an explicit opt-in in .env.local, so a
//      developer who HAS real Entra credentials locally gets the real flow.
export const DEV_MOCK_PROVIDER_ID = "dev-mock-login";

export function isDevMockAuthEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.DEV_MOCK_AUTH === "true";
}

export function devMockProvider() {
  return Credentials({
    id: DEV_MOCK_PROVIDER_ID,
    name: "Local development login",
    credentials: {},
    async authorize() {
      // Re-checked at call time, not just at registration, as a second guard.
      if (!isDevMockAuthEnabled()) return null;
      // Optional: sign in locally as a specific identity (e.g. an email that has
      // a row in the shared user-management table). The role still comes from
      // User Management (the data source), never from this setting.
      const email = process.env.DEV_MOCK_AUTH_EMAIL?.trim() || "dev.user@localhost";
      const name = process.env.DEV_MOCK_AUTH_NAME?.trim() || "Local Dev User";
      return { id: `local-dev:${email}`, name, email };
    },
  });
}
