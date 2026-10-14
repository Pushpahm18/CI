import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * LOCAL MOCK USERS — development preview only.
 *
 * Shown on the User Management page only when the page is built by `next dev`
 * (NODE_ENV=development) and only after the developer clicks "Show local mock
 * users". They exist in the browser only: they are never sent to the server,
 * never written to Databricks, and never used to authorize anyone. Every id,
 * name and address is marked MOCK / @mock.invalid so they cannot be mistaken
 * for real records. The set deliberately includes records that would be
 * flagged for review (inactive, NULL active flag, two rows for one email).
 */

const base = { lastSignIn: "", status: "Active", isActive: true as boolean | null };

export const DEV_MOCK_USERS: CiUserRecordRaw[] = [
  { ...base, id: "MOCK-1", userName: "MOCK Corporate Marketing", email: "mock.cm@mock.invalid", role: "Corporate Marketing", customer: "All", segment: "All", region: "All", lastSignIn: "2026-10-01T09:00:00Z" },
  { ...base, id: "MOCK-2", userName: "MOCK Account Team (one customer)", email: "mock.at1@mock.invalid", role: "Account Team", customer: '["Samsung"]', segment: '["DRAM","NAND"]', region: '["KOR"]' },
  { ...base, id: "MOCK-3", userName: "MOCK Account Team (several)", email: "mock.at2@mock.invalid", role: "Account Team", customer: '["TSMC","UMC"]', segment: '["Foundry"]', region: '["TWN","CHN"]' },
  { ...base, id: "MOCK-4", userName: "MOCK Inactive User", email: "mock.inactive@mock.invalid", role: "Account Team", customer: '["Intel"]', segment: '["Logic"]', region: '["US"]', status: "Inactive", isActive: false },
  { ...base, id: "MOCK-5", userName: "MOCK Unclear Flag", email: "mock.null@mock.invalid", role: "Account Team", customer: '["Micron"]', segment: '["DRAM"]', region: '["US"]', isActive: null },
  { ...base, id: "MOCK-6", userName: "MOCK Duplicate (row 1)", email: "mock.dup@mock.invalid", role: "Account Team", customer: '["Sony"]', segment: '["CIS"]', region: '["JPN"]' },
  { ...base, id: "MOCK-7", userName: "MOCK Duplicate (row 2)", email: "mock.dup@mock.invalid", role: "Account Team", customer: '["Kioxia"]', segment: '["NAND"]', region: '["JPN"]' },
];

/**
 * The local development login's page-level authorization records: the mock users
 * above plus the dev login itself as a MOCK Corporate Marketing user (unless its
 * email is already one of the mock users, e.g. DEV_MOCK_AUTH_EMAIL=mock.at1@mock.invalid
 * to try the Account Team view). Used ONLY by the page gate and session in
 * development mode (server/ci/access.ts); never by any API that returns real data.
 */
export function devMockAuthRecords(devLoginEmail: string): CiUserRecordRaw[] {
  const email = devLoginEmail.trim().toLowerCase();
  if (DEV_MOCK_USERS.some((u) => u.email === email)) return DEV_MOCK_USERS;
  return [
    ...DEV_MOCK_USERS,
    { ...base, id: "MOCK-DEV", userName: "MOCK Local Dev Login", email, role: "Corporate Marketing", customer: "All", segment: "All", region: "All" },
  ];
}
