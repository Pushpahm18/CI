/**
 * ONE rule for "which email identifies a person", shared by Microsoft sign-in and by
 * User Management's Microsoft-directory flow, so a person who is added can always be
 * recognised when they sign in.
 *
 *   Sign-in (src/auth.ts)       the ID token's `email` claim (Entra fills it from the user's
 *                               `mail` attribute), else `preferred_username` (the UPN).
 *   Directory (directory.ts)    the user's `mail` attribute, else `userPrincipalName`.
 *
 * Both are "mail first, UPN only when there is no mail". A guest account is the clearest case
 * where the two differ: its UPN looks like name_partner.com#EXT#@tenant.onmicrosoft.com but it
 * signs in with its real mail address. Matching against the access table is case-insensitive
 * (server/ci/authorization/ci-access.ts), so only trimming happens here.
 */

const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The identity email Microsoft sign-in hands to the session. */
export function emailFromSignInClaims(claims: { email?: unknown; preferred_username?: unknown }): string {
  return clean(claims.email) || clean(claims.preferred_username);
}

/** The identity email to save for a person chosen from the Microsoft directory. */
export function emailFromDirectoryUser(user: { mail?: unknown; userPrincipalName?: unknown }): string {
  return clean(user.mail) || clean(user.userPrincipalName);
}

/** Every address that can identify this directory person (canonical email first), lower-cased and without repeats. */
export function directoryAliases(user: { mail?: unknown; userPrincipalName?: unknown }): string[] {
  const all = [emailFromDirectoryUser(user), clean(user.mail), clean(user.userPrincipalName)].map((v) => v.toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}
