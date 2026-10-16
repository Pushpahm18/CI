import { describe, expect, it } from "vitest";
import { RECORD_COLUMNS } from "@/lib/ci/main-columns";
import { MAIN_COLUMNS } from "@/server/db/main-columns";

describe("the browser's ci_main column names", () => {
  it("are exactly the verified server column names", () => {
    expect(RECORD_COLUMNS.recordId).toBe(MAIN_COLUMNS.recordId);
    expect(RECORD_COLUMNS.customer).toBe(MAIN_COLUMNS.customer);
    expect(RECORD_COLUMNS.servedMarket).toBe(MAIN_COLUMNS.servedMarket);
    expect(RECORD_COLUMNS.quarter).toBe(MAIN_COLUMNS.quarter);
    expect(RECORD_COLUMNS.year).toBe(MAIN_COLUMNS.year);
    expect(RECORD_COLUMNS.createdOn).toBe(MAIN_COLUMNS.createdOn);
    expect(RECORD_COLUMNS.modifiedOn).toBe(MAIN_COLUMNS.modifiedOn);
    expect(RECORD_COLUMNS.active).toBe(MAIN_COLUMNS.active);
    expect(RECORD_COLUMNS.applicationId).toBe(MAIN_COLUMNS.applicationId);
  });
});
