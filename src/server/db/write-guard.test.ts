import { describe, expect, it } from "vitest";
import { assertCiWriteStatement } from "@/server/db/write-guard";

describe("CI write guard", () => {
  it("allows writes to corp_marketing_dev.ci tables", () => {
    for (const s of [
      "MERGE INTO `corp_marketing_dev`.`ci`.`ci_lookup` AS t USING (SELECT 'a' AS x) AS s ON t.x = s.x WHEN NOT MATCHED THEN INSERT *",
      "UPDATE `corp_marketing_dev`.`ci`.`ci_lookup` SET `is_active` = FALSE WHERE `lookup_id` = 'x'",
      "INSERT INTO corp_marketing_dev.ci.ci_login_history (a) SELECT 1 AS a",
    ]) expect(() => assertCiWriteStatement(s)).not.toThrow();
  });

  it("allows appending to the audit history and login history tables, and nothing else outside corp_marketing_dev.ci", () => {
    expect(() => assertCiWriteStatement("INSERT INTO `corp_marketing_dev`.`audit`.`ci_audit_history` (`audit_id`) VALUES ('a')")).not.toThrow();
    expect(() => assertCiWriteStatement("INSERT INTO corp_marketing_dev.audit.CI_AUDIT_HISTORY (audit_id) VALUES ('a')")).not.toThrow();
    expect(() => assertCiWriteStatement("INSERT INTO `corp_marketing_dev`.`audit`.`ci_login_history` (`login_id`) VALUES ('a')")).not.toThrow();
  });

  it("keeps the audit and login history append-only and every other audit table closed", () => {
    for (const s of [
      "UPDATE corp_marketing_dev.audit.ci_login_history SET result = 'x' WHERE login_id = 'a'",
      "DELETE FROM corp_marketing_dev.audit.ci_login_history WHERE login_id = 'a'",
      "MERGE INTO corp_marketing_dev.audit.ci_login_history AS t USING (SELECT 1) AS s ON 1=1 WHEN MATCHED THEN UPDATE SET t.a = 1",
      "UPDATE corp_marketing_dev.audit.ci_audit_history SET new_value = 'x' WHERE audit_id = 'a'",
      "DELETE FROM corp_marketing_dev.audit.ci_audit_history WHERE audit_id = 'a'",
      "MERGE INTO corp_marketing_dev.audit.ci_audit_history AS t USING (SELECT 1) AS s ON 1=1 WHEN MATCHED THEN UPDATE SET t.a = 1",
      "INSERT OVERWRITE corp_marketing_dev.audit.ci_audit_history SELECT 1",
      "INSERT INTO corp_marketing_dev.audit.something_else (a) VALUES (1)",
      "INSERT INTO other_catalog.audit.ci_audit_history (a) VALUES (1)",
    ]) expect(() => assertCiWriteStatement(s), s).toThrow(/Refused/);
  });

  it("refuses every SAMBA table and any other schema or catalog", () => {
    for (const s of [
      "MERGE INTO `corp_marketing_dev`.`samba`.`samba_usermanagement` AS t USING (SELECT 1) AS s ON 1=1",
      "UPDATE corp_marketing_dev.samba.samba_user SET a = 1",
      "INSERT INTO `corp_marketing_dev`.`samba`.`samba_user` (a) SELECT 1",
      "DELETE FROM corp_marketing_dev.samba.samba_user",
      "UPDATE other_catalog.ci.ci_lookup SET a = 1",
      "UPDATE corp_marketing_dev.other.ci_lookup SET a = 1",
    ]) expect(() => assertCiWriteStatement(s)).toThrow(/Refused/);
  });

  it("refuses a write that merely mentions SAMBA alongside a CI target", () => {
    expect(() => assertCiWriteStatement("UPDATE corp_marketing_dev.ci.ci_lookup SET a = (SELECT b FROM corp_marketing_dev.samba.samba_user)")).toThrow(/SAMBA/);
  });

  it("refuses DDL, maintenance commands and statements with no target", () => {
    for (const s of [
      "DROP TABLE corp_marketing_dev.ci.ci_lookup",
      "TRUNCATE TABLE corp_marketing_dev.ci.ci_lookup",
      "ALTER TABLE corp_marketing_dev.ci.ci_lookup ADD COLUMNS (x INT)",
      "CREATE TABLE corp_marketing_dev.ci.t (x INT)",
      "VACUUM corp_marketing_dev.ci.ci_lookup",
      "SELECT 1",
      "",
    ]) expect(() => assertCiWriteStatement(s)).toThrow(/Refused/);
  });

  it("ignores quoted values: a 'samba' value does not trip it and cannot hide a table", () => {
    expect(() => assertCiWriteStatement("UPDATE corp_marketing_dev.ci.ci_lookup SET lookup_value = 'samba DROP' WHERE lookup_id = 'x'")).not.toThrow();
    expect(() => assertCiWriteStatement("UPDATE corp_marketing_dev.samba.t SET a = 'corp_marketing_dev.ci.x'")).toThrow(/Refused/);
  });
});
