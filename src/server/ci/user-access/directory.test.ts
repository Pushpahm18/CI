import { afterEach, describe, expect, it, vi } from "vitest";

// A fake fetch stands in for Microsoft: no token request or Graph call leaves this machine.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("listDirectoryUsers", () => {
  it("asks Graph for mail too and returns the identity email: mail first, the UPN when there is no mail", async () => {
    vi.stubEnv("AZURE_TENANT_ID", "tenant-x");
    vi.stubEnv("AZURE_CLIENT_ID", "client-x");
    vi.stubEnv("AZURE_CLIENT_SECRET", "secret-x");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "t", expires_in: 3600 });
        return Response.json({
          value: [
            { id: "1", displayName: "Ann Lee", userPrincipalName: "ann@corp.onmicrosoft.com", mail: "Ann.Lee@corp.example.com" },
            { id: "2", displayName: "Bob Ray", userPrincipalName: "bob@corp.example.com", mail: null },
            { id: "3", displayName: "No UPN", mail: "x@y.com" },
          ],
        });
      })
    );
    const { listDirectoryUsers } = await import("@/server/ci/user-access/directory");
    const users = await listDirectoryUsers();
    expect(users).toEqual([
      { id: "1", displayName: "Ann Lee", userPrincipalName: "ann@corp.onmicrosoft.com", mail: "Ann.Lee@corp.example.com", email: "Ann.Lee@corp.example.com" },
      { id: "2", displayName: "Bob Ray", userPrincipalName: "bob@corp.example.com", mail: "", email: "bob@corp.example.com" },
    ]);
    const graph = urls.find((u) => u.includes("graph.microsoft.com"))!;
    expect(decodeURIComponent(graph)).toContain("$select=id,displayName,userPrincipalName,mail");
  });
});
