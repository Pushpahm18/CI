import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { assertCiWriteStatement } from "@/server/db/write-guard";
import { CI_TABLES, USER_ACCESS_COLUMNS, ciTableName } from "@/server/db/schema";
import {
  assertUserAccessWriteStatement,
  buildAddAccessStatement,
  buildHasAccessStatement,
  buildListAccessStatement,
  createUserAccessStore,
  rowToAccess,
} from "@/server/ci/databricks/user-access";

// Fake names and fakes only: no Databricks connection is opened and nothing is written.

const T = "corp_marketing_dev.ci.ci_user_access";
const AT = "2026-10-14T10:00:00.000Z";

describe("ci_user_access configuration", () => {
  it("is the real table, with exactly its own columns", () => {
    expect(ciTableName("userAccess", CI_TABLES)).toBe(T);
    expect(USER_ACCESS_COLUMNS).toEqual({
      id: "ci_user_access_id", userName: "user_name", email: "user_email",
      createdBy: "created_by", createdOn: "created_on", modifiedBy: "modified_by", modifiedOn: "modified_on", active: "is_active",
    });
  });
});

describe("statements", () => {
  it("lists every row with an email, newest first, as a read-only SELECT (no active filter, like SAMBA)", () => {
    const sql = buildListAccessStatement(T);
    expect(sql).toContain("`user_email` IS NOT NULL AND `user_email` <> ''");
    expect(sql).toContain("ORDER BY `created_on` DESC");
    expect(sql).not.toContain("`is_active` =");
    expect(sql).not.toContain("*");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("checks for an ACTIVE row by email, case-insensitively, and escapes the value", () => {
    const sql = buildHasAccessStatement(T, " Ann.Lee@Corp.com ");
    expect(sql).toContain("LOWER(TRIM(`user_email`)) = 'ann.lee@corp.com'");
    expect(sql).toContain("`is_active` = TRUE");
    expect(buildHasAccessStatement(T, "x'; DROP TABLE t; --")).toContain("'x''; drop table t; --'");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("adds with ONE MERGE that only inserts when the email has no row, and passes both write guards", () => {
    const sql = buildAddAccessStatement(T, { id: "id-1", name: "Ann O'Lee", email: " Ann.Lee@Corp.com ", actor: "Sree O'Neil", now: AT });
    expect(sql.startsWith("MERGE INTO `corp_marketing_dev`.`ci`.`ci_user_access` AS t")).toBe(true);
    expect(sql).toContain("ON LOWER(TRIM(t.`user_email`)) = s.`user_email`");
    expect(sql).not.toMatch(/WHEN MATCHED|UPDATE SET|DELETE/);
    expect(sql).toContain("'ann.lee@corp.com' AS `user_email`");
    expect(sql).toContain("'Ann O''Lee' AS `user_name`");
    expect(sql).toContain("'Sree O''Neil' AS `created_by`");
    expect(sql).toContain("'Sree O''Neil' AS `modified_by`");
    expect(sql).toContain("CAST('2026-10-14T10:00:00.000Z' AS TIMESTAMP)");
    expect(sql).toContain("TRUE AS `is_active`");
    expect(() => assertUserAccessWriteStatement(T, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("refuses anything but that one insert-when-absent MERGE", () => {
    const good = buildAddAccessStatement(T, { id: "i", name: "A", email: "a@b.com", actor: "x", now: AT });
    for (const bad of [
      `UPDATE ${T} SET is_active = FALSE`,
      `DELETE FROM ${T}`,
      `INSERT INTO ${T} (a) VALUES (1)`,
      "MERGE INTO `other`.`t`.`x` AS t USING (SELECT 1) AS s ON 1=1 WHEN NOT MATCHED THEN INSERT *",
      good.replace("WHEN NOT MATCHED", "WHEN MATCHED THEN UPDATE SET t.a = 1 WHEN NOT MATCHED"),
      `${good}; DROP TABLE x`,
    ]) {
      expect(() => assertUserAccessWriteStatement(T, bad), bad.slice(0, 40)).toThrow(/Refused/);
    }
  });
});

describe("row mapping", () => {
  it("maps a row, lower-casing the email and blanking an unusable date", () => {
    expect(rowToAccess({ ci_user_access_id: " a1 ", user_name: " Ann Lee ", user_email: " Ann@Corp.com ", created_by: "Ann", created_on: AT, modified_by: null, modified_on: "nope", is_active: "true" })).toEqual({
      id: "a1", name: "Ann Lee", email: "ann@corp.com", createdBy: "Ann", createdOn: AT, modifiedBy: "", modifiedOn: "", active: true,
    });
    expect(rowToAccess({ is_active: "false" }).active).toBe(false);
    expect(rowToAccess({ is_active: null }).active).toBeNull();
  });
});

describe("the store", () => {
  const make = (query: (s: string) => Promise<Record<string, unknown>[]>, execute = vi.fn(async () => {})) =>
    ({ store: createUserAccessStore(T, { query, execute, now: () => AT, newId: () => "id-1" }), execute });

  it("has(): true only with an active row, false (without a query) for a blank email", async () => {
    expect(await make(async () => [{ cnt: "1" }]).store.has("Ann@Corp.com")).toBe(true);
    expect(await make(async () => [{ cnt: "0" }]).store.has("ann@corp.com")).toBe(false);
    const never = vi.fn(async () => [{ cnt: 1 }]);
    expect(await make(never).store.has("   ")).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it("add(): sends one guarded statement and reports whether OUR row landed", async () => {
    const landed = make(async () => [{ ci_user_access_id: "id-1", user_email: "ann@corp.com" }]);
    expect(await landed.store.add({ id: "id-1", name: "Ann", email: "ann@corp.com", actor: "Sree" })).toBe(true);
    expect(landed.execute).toHaveBeenCalledTimes(1);
    const taken = make(async () => [{ ci_user_access_id: "someone-else", user_email: "ann@corp.com" }]);
    expect(await taken.store.add({ id: "id-1", name: "Ann", email: "ann@corp.com", actor: "Sree" })).toBe(false);
  });
});
