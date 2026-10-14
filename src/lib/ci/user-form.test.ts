import { describe, expect, it, vi } from "vitest";
import { EMPTY_USER_FORM, SCOPE_LABELS, USER_ROLES, toLocalTestRecord, validateUserForm, type UserFormValues } from "@/lib/ci/user-form";
import { DEV_MOCK_USERS } from "@/lib/ci/dev-mock-users";
import { accountScopeFrom } from "@/server/ci/authorization/scope";

const ctx = { existing: DEV_MOCK_USERS, signedIn: { name: "Local Dev", email: "dev@yoda-tech.com" }, newId: () => "11111111-1111-4111-8111-111111111111" };
const at: UserFormValues = { userName: " Ann Lee ", email: " Ann.Lee@Yoda-Tech.com ", role: "Account Team", customers: ["TSMC", "UMC"], segments: ["Foundry"], regions: ["TWN"] };

describe("Add User form validation", () => {
  it("names the scope fields Customer, Served Market and Region", () => {
    expect(SCOPE_LABELS).toEqual({ customers: "Customer", segments: "Served Market", regions: "Region" });
  });

  it("offers exactly the two CI roles and no Admin", () => {
    expect([...USER_ROLES]).toEqual(["Account Team", "Corporate Marketing"]);
    expect(validateUserForm({ ...at, role: "Admin" }, ctx).errors.role).toMatch(/Account Team or Corporate Marketing/);
  });

  it("accepts a valid Account Team user and proposes the exact row a save would insert", () => {
    const r = validateUserForm(at, ctx);
    expect(r.errors).toEqual({});
    expect(r.proposed).toEqual({
      ci_user_id: "11111111-1111-4111-8111-111111111111",
      user_name: "Ann Lee",
      user_email: "ann.lee@yoda-tech.com",
      role_name: "Account Team",
      customer: '["TSMC","UMC"]',
      segment: '["Foundry"]',
      region: '["TWN"]',
      status: "Active",
      last_sign_in: null,
      is_active: true,
      created_by: "Local Dev",
      modified_by: "Local Dev",
    });
    // the proposed scope text passes the same strict reader the authorizer uses
    expect(accountScopeFrom({ customer: r.proposed!.customer, segment: r.proposed!.segment, region: r.proposed!.region }).ok).toBe(true);
  });

  it("Corporate Marketing is fixed to All / All / All whatever scope was typed", () => {
    const r = validateUserForm({ ...at, role: "Corporate Marketing", customers: ["X"], segments: [], regions: [] }, ctx);
    expect(r.errors).toEqual({});
    expect(r.proposed).toMatchObject({ role_name: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
  });

  it("accepts the local development login's name@localhost address in a development build only", () => {
    const dev = { ...at, email: "dev.user@localhost" };
    vi.stubEnv("NODE_ENV", "development");
    expect(validateUserForm(dev, ctx).errors.email).toBeUndefined();
    expect(validateUserForm({ ...dev, email: "Dev.User@LOCALHOST" }, ctx).errors.email).toBeUndefined();
    // still rejected: other single-label domains, and a list of addresses
    for (const bad of ["bob@company", "a@localhost, b@localhost", "a b@localhost"]) expect(validateUserForm({ ...at, email: bad }, ctx).errors.email, bad).toBeTruthy();
    vi.stubEnv("NODE_ENV", "production");
    expect(validateUserForm(dev, ctx).errors.email).toMatch(/valid email/);
    vi.stubEnv("NODE_ENV", "test");
    expect(validateUserForm(dev, ctx).errors.email).toMatch(/valid email/);
    vi.unstubAllEnvs();
  });

  it("requires name, a single valid email and a role", () => {
    const r = validateUserForm(EMPTY_USER_FORM, ctx);
    expect(Object.keys(r.errors).sort()).toEqual(["email", "role", "userName"]);
    for (const email of ["x", "a@b", "a@b.com, c@d.com", "a b@c.com", "a@b.com;c@d.com"]) {
      expect(validateUserForm({ ...at, email }, ctx).errors.email, email).toBeTruthy();
    }
    expect(validateUserForm({ ...at, userName: "x".repeat(201) }, ctx).errors.userName).toBeTruthy();
  });

  it("Account Team needs each scope to be All or at least one valid value; All cannot be listed as a value", () => {
    expect(Object.keys(validateUserForm({ ...at, customers: [], segments: [], regions: [] }, ctx).errors).sort()).toEqual(["customers", "regions", "segments"]);
    expect(validateUserForm({ ...at, customers: [] }, ctx).errors.customers).toMatch(/choose All, or add at least one value/);
    expect(validateUserForm({ ...at, customers: ["All"] }, ctx).errors.customers).toMatch(/All cannot be listed/);
    expect(validateUserForm({ ...at, customers: ["All", "UMC"] }, ctx).errors.customers).toMatch(/All cannot be listed/);
    expect(validateUserForm({ ...at, regions: ["KOR", "KOR"] }, ctx).errors.regions).toMatch(/repeated/);
    expect(validateUserForm({ ...at, segments: ["  "] }, ctx).errors.segments).toBeTruthy();
  });

  it("Account Team accepts every All / specific combination and stores All as the text All", () => {
    const combos: Array<[UserFormValues["customers"], UserFormValues["segments"], UserFormValues["regions"], [string, string, string]]> = [
      ["All", "All", "All", ["All", "All", "All"]],
      [["UMC"], "All", "All", ['["UMC"]', "All", "All"]],
      [["UMC"], ["Foundry"], "All", ['["UMC"]', '["Foundry"]', "All"]],
      [["UMC"], ["Foundry"], ["TWN"], ['["UMC"]', '["Foundry"]', '["TWN"]']],
      ["All", ["Logic", "DRAM"], ["KOR", "CHN"], ["All", '["Logic","DRAM"]', '["KOR","CHN"]']],
    ];
    for (const [customers, segments, regions, [c, s, g]] of combos) {
      const r = validateUserForm({ ...at, customers, segments, regions }, ctx);
      expect(r.errors, JSON.stringify([customers, segments, regions])).toEqual({});
      expect(r.proposed).toMatchObject({ customer: c, segment: s, region: g });
      expect(accountScopeFrom({ customer: r.proposed!.customer, segment: r.proposed!.segment, region: r.proposed!.region }).ok).toBe(true);
    }
  });

  it("validates selected values against an approved master list when one is supplied, and only then", () => {
    const masters = { segments: ["Foundry", "Logic"], regions: [] as string[] };
    const bad = validateUserForm({ ...at, segments: ["Foundry", "Quantum"] }, { ...ctx, masters });
    expect(bad.errors.segments).toMatch(/“Quantum” is not in the approved Served Market list/);
    expect(validateUserForm({ ...at, segments: ["Foundry"] }, { ...ctx, masters }).errors).toEqual({});
    // an empty master (nothing approved yet) is not enforced; Customer has no master at all
    expect(validateUserForm({ ...at, regions: ["ANY"] }, { ...ctx, masters }).errors).toEqual({});
    expect(validateUserForm({ ...at, segments: "All" }, { ...ctx, masters }).errors).toEqual({});
  });

  it("keeps one record per email: any existing record for the email blocks a new one, even an inactive one", () => {
    expect(validateUserForm({ ...at, email: "MOCK.CM@mock.invalid" }, ctx).errors.email).toMatch(/one record per email/);
    expect(validateUserForm({ ...at, email: "mock.inactive@mock.invalid" }, ctx).errors.email).toMatch(/one record per email/);
  });

  it("warns, but does not block, an address outside the signed-in user's domain", () => {
    const r = validateUserForm({ ...at, email: "ann@other.com" }, ctx);
    expect(r.errors).toEqual({});
    expect(r.warnings[0]).toMatch(/not in your domain \(yoda-tech\.com\)/);
    expect(validateUserForm(at, ctx).warnings).toEqual([]);
  });

  it("a hostile name or scope value is kept as plain text, never executable", () => {
    const r = validateUserForm({ ...at, userName: "x'); DROP TABLE t; --", customers: ["a'b"] }, ctx);
    expect(r.errors).toEqual({});
    expect(r.proposed!.customer).toBe('["a\'b"]');
  });

  it("a local test entry is marked MOCK and cannot be mistaken for a real record", () => {
    const r = validateUserForm(at, ctx);
    const rec = toLocalTestRecord(r.proposed!, 1);
    expect(rec.id).toBe("MOCK-LOCAL-1");
    expect(rec.userName).toMatch(/^MOCK \(local test\)/);
    expect(rec.isActive).toBe(true);
  });
});
