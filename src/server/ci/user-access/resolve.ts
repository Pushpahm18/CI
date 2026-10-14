import { CiError, DisabledError, ValidationError } from "@/server/ci/errors";
import { MICROSOFT_DIRECTORY_PICKER_ENABLED } from "@/lib/ci/directory-picker";
import { directoryAliases } from "@/lib/ci/identity-email";
import { isDirectoryConfigured, listDirectoryUsers } from "@/server/ci/user-access/directory";
import { isDevMockAuthEnabled } from "@/server/dev-auth";
import type { DirectoryUser } from "@/types/ci-api";

/**
 * Server-side check that a person being added to CI User Management really is in the
 * Microsoft Entra directory. The browser's picker is a convenience only: the name and
 * email it sends are never trusted. When the directory can be read, the saved email is
 * the directory's identity email (mail, else the user principal name - the same rule sign-in
 * uses, lib/ci/identity-email.ts) and the saved name is its display name.
 *
 * Local development only: while the directory cannot be read (not configured, or the app
 * has no Graph permission yet) the typed name and email are accepted, exactly as before.
 * That can never apply to a production build (server/dev-auth.ts).
 */

export const DIRECTORY_PERMISSION_MESSAGE =
  "Microsoft directory search is not permitted for this app yet. A Microsoft Entra administrator must grant the Microsoft Graph application permission User.Read.All and give admin consent.";
export const DIRECTORY_CREDENTIALS_MESSAGE =
  "Microsoft rejected this app's credentials, so the directory could not be read. Check the Microsoft client ID, tenant and secret on the server.";
export const DIRECTORY_UNAVAILABLE_MESSAGE = "Unable to load organization users. Please try again.";
export const DIRECTORY_NOT_CONFIGURED_MESSAGE =
  "Microsoft directory search is not configured on this server, so users cannot be added yet. Nothing was saved.";
export const NOT_IN_DIRECTORY_MESSAGE =
  "That email is not in the Microsoft organization directory. Select the person from the directory list.";

/** A safe, user-readable reason for a directory failure (never includes a response body or a secret). */
export function describeDirectoryFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (/Graph user list failed \((401|403)\)/.test(text)) return DIRECTORY_PERMISSION_MESSAGE;
  if (/Failed to authenticate with Microsoft Entra ID/.test(text)) return DIRECTORY_CREDENTIALS_MESSAGE;
  return DIRECTORY_UNAVAILABLE_MESSAGE;
}

export interface DirectoryUserDeps {
  /** The Microsoft directory picker switch (lib/ci/directory-picker.ts); off = the typed name and email are used as they are. */
  pickerEnabled(): boolean;
  directoryConfigured(): boolean;
  directory(): Promise<DirectoryUser[]>;
  devAccess(): boolean;
}

const defaultDeps: DirectoryUserDeps = {
  pickerEnabled: () => MICROSOFT_DIRECTORY_PICKER_ENABLED,
  directoryConfigured: () => isDirectoryConfigured(),
  directory: listDirectoryUsers,
  devAccess: isDevMockAuthEnabled,
};

/** The verified person: the email to save, the name, and every address that identifies them (for the one-record-per-person check). */
export interface ResolvedPerson {
  email: string;
  userName: string;
  aliases: string[];
}

export async function resolveDirectoryUser(
  email: string,
  typedName: string,
  deps: DirectoryUserDeps = defaultDeps
): Promise<ResolvedPerson> {
  const key = email.trim().toLowerCase();
  const typed = { email: key, userName: typedName.trim(), aliases: key ? [key] : [] };
  if (!key) return typed; // the form validation reports the missing email
  if (!deps.pickerEnabled()) return typed; // picker switched off: no directory lookup at all

  if (!deps.directoryConfigured()) {
    if (deps.devAccess()) return typed;
    throw new DisabledError(DIRECTORY_NOT_CONFIGURED_MESSAGE);
  }

  let users: DirectoryUser[];
  try {
    users = await deps.directory();
  } catch (error) {
    console.error("[CI] user directory check failed:", error instanceof Error ? error.message : error);
    if (deps.devAccess()) return typed;
    throw new CiError(`${describeDirectoryFailure(error)} Nothing was saved.`, 502, "INTERNAL");
  }

  // The person may be named by their mail address or by their UPN; either finds them.
  const match = users.find((u) => directoryAliases(u).includes(key));
  if (!match) throw new ValidationError([NOT_IN_DIRECTORY_MESSAGE]);
  const aliases = directoryAliases(match);
  return { email: aliases[0], userName: match.displayName.trim(), aliases };
}
