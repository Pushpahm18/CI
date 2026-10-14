import { describe, expect, it, vi } from "vitest";
import { CiError, DisabledError, ValidationError } from "@/server/ci/errors";
import { MICROSOFT_DIRECTORY_PICKER_ENABLED } from "@/lib/ci/directory-picker";
import {
  DIRECTORY_CREDENTIALS_MESSAGE,
  DIRECTORY_NOT_CONFIGURED_MESSAGE,
  DIRECTORY_PERMISSION_MESSAGE,
  DIRECTORY_UNAVAILABLE_MESSAGE,
  describeDirectoryFailure,
  resolveDirectoryUser,
  type DirectoryUserDeps,
} from "@/server/ci/user-access/resolve";

// Fakes only: no Microsoft Graph call, no database.

const ann = { id: "1", displayName: "Ann Lee", userPrincipalName: "Ann.Lee@Corp.example.com", mail: "", email: "Ann.Lee@Corp.example.com" };
// A person whose mail address differs from their UPN.
const cal = { id: "2", displayName: "Cal Ray", userPrincipalName: "cal@corp.onmicrosoft.com", mail: "Cal.Ray@Corp.example.com", email: "Cal.Ray@Corp.example.com" };

function make(over: Partial<DirectoryUserDeps> = {}): DirectoryUserDeps {
  return { pickerEnabled: () => true, directoryConfigured: () => true, directory: async () => [ann, cal], devAccess: () => false, ...over };
}

describe("resolveDirectoryUser", () => {
  it("returns the directory's own email (lower-cased) and display name, whatever the browser typed", async () => {
    expect(await resolveDirectoryUser("  ann.lee@corp.example.com ", "Typed Name", make())).toEqual({ email: "ann.lee@corp.example.com", userName: "Ann Lee", aliases: ["ann.lee@corp.example.com"] });
  });

  it("saves mail when the person has one, whether the browser sent the mail address or the UPN, and reports both addresses", async () => {
    const expected = { email: "cal.ray@corp.example.com", userName: "Cal Ray", aliases: ["cal.ray@corp.example.com", "cal@corp.onmicrosoft.com"] };
    expect(await resolveDirectoryUser("Cal.Ray@Corp.example.com", "x", make())).toEqual(expected);
    expect(await resolveDirectoryUser("cal@corp.onmicrosoft.com", "x", make())).toEqual(expected);
  });

  it("refuses an email that is not in the directory", async () => {
    const err = await resolveDirectoryUser("nobody@corp.example.com", "Nobody", make()).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details?.join(" ")).toContain("not in the Microsoft organization directory");
  });

  it("refuses everything when the directory is not configured and this is not local development", async () => {
    await expect(resolveDirectoryUser("ann.lee@corp.example.com", "Ann", make({ directoryConfigured: () => false }))).rejects.toBeInstanceOf(DisabledError);
    await expect(resolveDirectoryUser("ann.lee@corp.example.com", "Ann", make({ directoryConfigured: () => false }))).rejects.toThrow(DIRECTORY_NOT_CONFIGURED_MESSAGE);
  });

  it("refuses when the directory cannot be read and this is not local development, with the actionable reason", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = make({ directory: async () => { throw new Error("Microsoft Graph user list failed (403)."); } });
    const err = (await resolveDirectoryUser("ann.lee@corp.example.com", "Ann", failing).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).toContain("User.Read.All");
    expect(err.message).toContain("Nothing was saved");
    spy.mockRestore();
  });

  it("local development with the dev login only: accepts the typed name and email when the directory is unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveDirectoryUser("Dev@Local.test ", " Dev Person ", make({ directoryConfigured: () => false, devAccess: () => true }))).toEqual({ email: "dev@local.test", userName: "Dev Person", aliases: ["dev@local.test"] });
    const failing = make({ devAccess: () => true, directory: async () => { throw new Error("Microsoft Graph user list failed (403)."); } });
    expect(await resolveDirectoryUser("dev@local.test", "Dev Person", failing)).toEqual({ email: "dev@local.test", userName: "Dev Person", aliases: ["dev@local.test"] });
    spy.mockRestore();
  });

  it("even in local development, a readable directory is the authority: an unknown email is refused", async () => {
    await expect(resolveDirectoryUser("nobody@corp.example.com", "Nobody", make({ devAccess: () => true }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("with the picker switched off it uses the typed name and email and never touches the directory", async () => {
    const directory = vi.fn(async () => [ann]);
    const off = make({ pickerEnabled: () => false, directoryConfigured: () => true, directory });
    expect(await resolveDirectoryUser(" New.Person@Corp.example.com ", " New Person ", off)).toEqual({ email: "new.person@corp.example.com", userName: "New Person", aliases: ["new.person@corp.example.com"] });
    expect(directory).not.toHaveBeenCalled();
  });

  it("the shipped switch is on (the owner asked for the Microsoft picker)", () => {
    expect(MICROSOFT_DIRECTORY_PICKER_ENABLED).toBe(true);
  });

  it("leaves a blank email to the form validation", async () => {
    expect(await resolveDirectoryUser("  ", "A", make())).toEqual({ email: "", userName: "A", aliases: [] });
  });
});

describe("describeDirectoryFailure", () => {
  it("maps known failures to safe sentences and never echoes the raw error", () => {
    expect(describeDirectoryFailure(new Error("Microsoft Graph user list failed (403)."))).toBe(DIRECTORY_PERMISSION_MESSAGE);
    expect(describeDirectoryFailure(new Error("Microsoft Graph user list failed (401)."))).toBe(DIRECTORY_PERMISSION_MESSAGE);
    expect(describeDirectoryFailure(new Error("Failed to authenticate with Microsoft Entra ID (401)."))).toBe(DIRECTORY_CREDENTIALS_MESSAGE);
    expect(describeDirectoryFailure(new Error("Unable to reach Microsoft Graph. secret-detail"))).toBe(DIRECTORY_UNAVAILABLE_MESSAGE);
    expect(describeDirectoryFailure("odd")).toBe(DIRECTORY_UNAVAILABLE_MESSAGE);
  });
});
