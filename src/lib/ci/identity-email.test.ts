import { describe, expect, it } from "vitest";
import { directoryAliases, emailFromDirectoryUser, emailFromSignInClaims } from "@/lib/ci/identity-email";

// Pure functions: no network, no database.

describe("one identity email for sign-in and for the directory", () => {
  it("sign-in prefers the email claim and falls back to preferred_username (the UPN)", () => {
    expect(emailFromSignInClaims({ email: " Ann.Lee@corp.example.com ", preferred_username: "ann@corp.onmicrosoft.com" })).toBe("Ann.Lee@corp.example.com");
    expect(emailFromSignInClaims({ preferred_username: "ann@corp.onmicrosoft.com" })).toBe("ann@corp.onmicrosoft.com");
    expect(emailFromSignInClaims({ email: "", preferred_username: "ann@corp.onmicrosoft.com" })).toBe("ann@corp.onmicrosoft.com");
    expect(emailFromSignInClaims({ email: "   ", preferred_username: " " })).toBe("");
    expect(emailFromSignInClaims({})).toBe("");
  });

  it("the directory prefers mail and falls back to the user principal name", () => {
    expect(emailFromDirectoryUser({ mail: " Ann.Lee@corp.example.com ", userPrincipalName: "ann@corp.onmicrosoft.com" })).toBe("Ann.Lee@corp.example.com");
    expect(emailFromDirectoryUser({ mail: null, userPrincipalName: "ann@corp.onmicrosoft.com" })).toBe("ann@corp.onmicrosoft.com");
    expect(emailFromDirectoryUser({ mail: "", userPrincipalName: "ann@corp.onmicrosoft.com" })).toBe("ann@corp.onmicrosoft.com");
  });

  it("a person saved from the directory is recognised at sign-in, for every combination of mail and UPN", () => {
    const people = [
      { mail: "ann.lee@corp.example.com", userPrincipalName: "ann@corp.onmicrosoft.com" }, // mail differs from the UPN
      { mail: "ann@corp.example.com", userPrincipalName: "ann@corp.example.com" }, // the usual case
      { mail: null, userPrincipalName: "bob@corp.example.com" }, // no mail attribute
      { mail: "partner@other.com", userPrincipalName: "partner_other.com#EXT#@corp.onmicrosoft.com" }, // guest
    ];
    for (const p of people) {
      // The ID token's email claim comes from mail; with no mail the claim is absent and preferred_username (the UPN) is used.
      const claims = { email: p.mail ?? undefined, preferred_username: p.userPrincipalName };
      expect(emailFromSignInClaims(claims).toLowerCase(), JSON.stringify(p)).toBe(emailFromDirectoryUser(p).toLowerCase());
    }
  });

  it("lists every address of a person once, canonical first, lower-cased", () => {
    expect(directoryAliases({ mail: "Ann.Lee@Corp.example.com", userPrincipalName: "ann@corp.onmicrosoft.com" })).toEqual(["ann.lee@corp.example.com", "ann@corp.onmicrosoft.com"]);
    expect(directoryAliases({ mail: "A@x.com", userPrincipalName: "a@X.com" })).toEqual(["a@x.com"]);
    expect(directoryAliases({ mail: null, userPrincipalName: "b@x.com" })).toEqual(["b@x.com"]);
    expect(directoryAliases({})).toEqual([]);
  });
});
