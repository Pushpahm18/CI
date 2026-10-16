import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/server/ci/errors";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { assertCiWriteStatement } from "@/server/db/write-guard";
import { FULL_SCOPE } from "@/lib/ci/rules";
import {
  assertNoteWriteStatement,
  buildInsertNotesStatement,
  buildListNotesStatement,
  createChangeNoteStore,
  rowToNote,
} from "@/server/ci/databricks/change-notes";
import {
  assertAuditWriteStatement,
  auditRows,
  buildInsertAuditStatement,
  buildListAuditStatement,
  createAuditHistoryStore,
  formatActionBy,
  parseActionBy,
  rowsToEntries,
  type AuditInput,
} from "@/server/ci/databricks/audit-history";
import {
  assertRecordWriteStatement,
  buildDiscardRecordStatement,
  buildGetRecordsStatement,
  applicationIdFor,
  buildInsertRecordStatement,
  buildMaxApplicationSeqStatement,
  buildListRecordsStatement,
  buildUpdateRecordStatement,
  createRecordStore,
} from "@/server/ci/databricks/records";
import { composeRepository, createRefusingRepository, usersFromRecords } from "@/server/ci/repository";
import type { CompetitiveRecord } from "@/types/ci";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fake names and fakes only: no Databricks connection is opened and nothing is written.

const NOTES = "corp_marketing_dev.ci.ci_change_note";
const AUDIT = "corp_marketing_dev.audit.ci_audit_history";
const MAIN = "corp_marketing_dev.ci.ci_main";
const AT = "2026-10-13T10:00:00.000Z";
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const record = (over: Partial<CompetitiveRecord> = {}): Omit<CompetitiveRecord, "recordId"> => ({
  quarter: "Q1", year: "2026", customer: "UMC", fabLocation: "UMC Hsinchu", fabRegion: "Taiwan", servedMarket: "Foundry", technologyNode: "28nm",
  waferSize: '300mm (12")', processApplication: "Liner", processType: "Selective", processLocation: "STI", films: "", productLine: "ALD",
  topCompetitor: "TEL", productName: "Trias", processModules: "2", orderType: "Module", actualOrder: 2, asp: 1.5, currency: "USD", revenue: 3,
  toolType: "ALD-VF", createdBy: "Ann Lee", createdOn: "2026-10-13", ...over,
});

describe("change notes (ci_change_note)", () => {
  const notes = [{ recordId: "r1", actionTakenBy: "Ann Lee", dateTime: AT, notes: "Initial entry; it's \"new\"" }];

  it("appends with one INSERT using only the table's own columns, and passes both write guards", () => {
    const sql = buildInsertNotesStatement(NOTES, notes, ids());
    expect(sql.startsWith("INSERT INTO `corp_marketing_dev`.`ci`.`ci_change_note` (")).toBe(true);
    for (const col of ["change_note_id", "ci_id", "action_taken_by", "action_timestamp", "additional_notes", "created_by", "created_on", "modified_by", "modified_on", "is_active"]) expect(sql).toContain("`" + col + "`");
    expect(sql).toContain("CAST('2026-10-13T10:00:00.000Z' AS TIMESTAMP)");
    expect(sql).toContain("TRUE");
    expect(sql).toContain(`it''s "new"`);
    expect(() => assertNoteWriteStatement(NOTES, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("refuses anything but one INSERT into the notes table", () => {
    for (const bad of [`UPDATE ${NOTES} SET a = 1`, `DELETE FROM ${NOTES}`, "INSERT INTO other.t.x (a) VALUES (1)", `INSERT INTO \`corp_marketing_dev\`.\`ci\`.\`ci_change_note\` (a) VALUES (1); DROP TABLE x`]) {
      expect(() => assertNoteWriteStatement(NOTES, bad)).toThrow(/Refused/);
    }
  });

  it("lists the live notes of one row, oldest first, as a read-only SELECT", () => {
    const sql = buildListNotesStatement(NOTES, "r'1");
    expect(sql).toContain("`ci_id` = 'r''1'");
    expect(sql).toContain("`is_active` IS NULL OR `is_active` = TRUE");
    expect(sql).toContain("ORDER BY `action_timestamp` ASC");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("maps a stored row to a note and goes through the store", async () => {
    expect(rowToNote({ change_note_id: "n1", ci_id: "r1", action_taken_by: "Ann Lee", action_timestamp: AT, additional_notes: "Hello" })).toEqual({ id: "n1", recordId: "r1", actionTakenBy: "Ann Lee", dateTime: AT, notes: "Hello" });
    const execute = vi.fn(async () => {});
    const store = createChangeNoteStore(NOTES, { query: async () => [{ change_note_id: "n1", ci_id: "r1", action_taken_by: "A", action_timestamp: AT, additional_notes: "x" }], execute, newId: ids() });
    expect(await store.list("r1")).toHaveLength(1);
    await store.add([]);
    expect(execute).not.toHaveBeenCalled();
    await store.add(notes);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("audit history (audit.ci_audit_history)", () => {
  const input = (over: Partial<AuditInput> = {}): AuditInput => ({
    entity: "Competitive Info", recordId: "r1", action: "Edited", note: "why", actionByName: "Ann Lee", actionByEmail: "ann@corp.com", at: AT,
    changes: [{ field: "customer", label: "Customer", previous: "UMC", current: "TSMC" }, { field: "films", label: "Films", previous: "", current: "SiN" }],
    ...over,
  });

  it("stores the person as 'Name <email>' and reads it back as a name and an email", () => {
    expect(formatActionBy("Ann Lee", "ann@corp.com")).toBe("Ann Lee <ann@corp.com>");
    expect(formatActionBy("Ann Lee")).toBe("Ann Lee");
    expect(formatActionBy("ann@corp.com", "ANN@corp.com")).toBe("ann@corp.com");
    expect(parseActionBy("Ann Lee <ann@corp.com>")).toEqual({ name: "Ann Lee", email: "ann@corp.com" });
    expect(parseActionBy("Local Dev User")).toEqual({ name: "Local Dev User", email: "" });
  });

  it("writes one row per changed field, with NULL for a missing value, and one empty-field row when a change has no detail", () => {
    const rows = auditRows([input(), input({ changes: [], note: undefined })], ids());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ entity_name: "Competitive Info", record_id: "r1", action_taken: "Edited", field_name: "Customer", old_value: "UMC", new_value: "TSMC", comments: "why", action_by: "Ann Lee <ann@corp.com>", created_by: "Ann Lee <ann@corp.com>" });
    expect(rows[1]).toMatchObject({ field_name: "Films", old_value: null, new_value: "SiN" });
    expect(rows[2]).toMatchObject({ field_name: null, old_value: null, new_value: null, comments: null });
  });

  it("appends with one INSERT, passes the write guard, and the guard keeps the table append-only", () => {
    const sql = buildInsertAuditStatement(AUDIT, [input()], ids());
    expect(sql.startsWith("INSERT INTO `corp_marketing_dev`.`audit`.`ci_audit_history` (")).toBe(true);
    for (const col of ["audit_id", "entity_name", "record_id", "action_taken", "field_name", "old_value", "new_value", "comments", "action_by", "action_timestamp"]) expect(sql).toContain("`" + col + "`");
    expect(() => assertAuditWriteStatement(AUDIT, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
    for (const bad of [`UPDATE ${AUDIT} SET a = 1`, `DELETE FROM ${AUDIT}`]) {
      expect(() => assertAuditWriteStatement(AUDIT, bad)).toThrow(/Refused/);
      expect(() => assertCiWriteStatement(bad)).toThrow(/Refused/);
    }
    // The login history table is allowed by the write guard (insert only), but it is not the audit table:
    // the audit store still refuses to write to anything but its own table.
    expect(() => assertAuditWriteStatement(AUDIT, "INSERT INTO corp_marketing_dev.audit.ci_login_history (a) VALUES (1)")).toThrow(/Refused/);
  });

  it("lists the entries of one record of one kind, newest first, as a read-only SELECT", () => {
    const sql = buildListAuditStatement(AUDIT, "Competitive Info", "r1");
    expect(sql).toContain("`entity_name` = 'Competitive Info'");
    expect(sql).toContain("`record_id` = 'r1'");
    expect(sql).toContain("ORDER BY `action_timestamp` DESC");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("puts the per-field rows of each change back together as one entry", () => {
    const row = (id: string, at: string, action: string, field: string | null, o: string | null, n: string | null) => ({
      audit_id: id, entity_name: "Competitive Info", record_id: "r1", action_taken: action, field_name: field, old_value: o, new_value: n, comments: "why", action_by: "Ann Lee <ann@corp.com>", action_timestamp: at,
    });
    const entries = rowsToEntries([
      row("a1", "2026-10-13T10:05:00.000Z", "Edited", "Fab Location", "A", "B"),
      row("a2", "2026-10-13T10:05:00.000Z", "Edited", "Customer", "UMC", "TSMC"),
      row("a3", "2026-10-13T09:00:00.000Z", "Created", "Quarter", null, "Q1"),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "a1", action: "Edited", actionTakenBy: "Ann Lee", actorEmail: "ann@corp.com", note: "why", dateTime: "2026-10-13T10:05:00.000Z" });
    expect(entries[0].changes).toEqual([
      { field: "fabLocation", label: "Fab Location", previous: "A", current: "B" },
      { field: "customer", label: "Customer", previous: "UMC", current: "TSMC" },
    ]);
    expect(entries[1].changes).toEqual([{ field: "quarter", label: "Quarter", previous: "", current: "Q1" }]);
  });

  it("the store sends nothing for an empty list and one guarded INSERT otherwise", async () => {
    const execute = vi.fn(async () => {});
    const store = createAuditHistoryStore(AUDIT, { query: async () => [], execute, newId: ids() });
    await store.add([]);
    expect(execute).not.toHaveBeenCalled();
    await store.add([input()]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.list("Competitive Info", "r1")).toEqual([]);
  });

  describe("manual entry vs bulk import (stored in the existing comments column; no table change)", () => {
    const base = (over: Partial<AuditInput> = {}): AuditInput => ({
      entity: "Competitive Info", recordId: "r1", action: "Created", note: "Initial entry.", actionByName: "Ann Lee", actionByEmail: "ann@corp.com", at: AT,
      changes: [{ field: "quarter", label: "Quarter", previous: "", current: "Q1" }],
      ...over,
    });
    const readBack = (rows: Record<string, unknown>[]) => rowsToEntries(rows.map((r) => ({ ...r, action_timestamp: AT })));

    it("a manual entry stores the Change Note exactly as typed, with no import marker", () => {
      const [row] = auditRows([base()], ids());
      expect(row.comments).toBe("Initial entry.");
      const [entry] = readBack([row]);
      expect(entry).toMatchObject({ action: "Created", actionTakenBy: "Ann Lee", actorEmail: "ann@corp.com", note: "Initial entry." });
      expect(entry.importType).toBeUndefined();
      expect(entry.sourceFile).toBeUndefined();
    });

    it("an import stores its type and file in a marker line before the note, and reads them back without it", () => {
      for (const importType of ["Historic Load", "Bulk Update", "Excel Import"] as const) {
        const [row] = auditRows([base({ action: importType === "Bulk Update" ? "Edited" : "Imported", importType, sourceFile: "rows q3.xlsx" })], ids());
        expect(row.comments).toBe(`[Bulk Import: ${importType} | file: rows q3.xlsx]\nInitial entry.`);
        const [entry] = readBack([row]);
        expect(entry).toMatchObject({ importType, sourceFile: "rows q3.xlsx", note: "Initial entry.", actionTakenBy: "Ann Lee" });
      }
    });

    it("an import with no note or no file name still round-trips", () => {
      const [onlyMarker] = auditRows([base({ action: "Imported", importType: "Excel Import", note: undefined, sourceFile: undefined })], ids());
      expect(onlyMarker.comments).toBe("[Bulk Import: Excel Import]");
      expect(readBack([onlyMarker])[0]).toMatchObject({ importType: "Excel Import", note: "" });
      expect(readBack([onlyMarker])[0].sourceFile).toBeUndefined();
    });

    it("a hostile file name cannot break out of the marker", () => {
      const [row] = auditRows([base({ action: "Imported", importType: "Excel Import", sourceFile: "a]\nFake note.xlsx" })], ids());
      const [entry] = readBack([row]);
      expect(entry.sourceFile).toBe("a Fake note.xlsx");
      expect(entry.note).toBe("Initial entry.");
    });

    it("older entries (no marker) are untouched, including a plain Imported entry from before", () => {
      const old = { audit_id: "o1", entity_name: "Competitive Info", record_id: "r1", action_taken: "Imported", field_name: null, old_value: null, new_value: null, comments: "Imported by Corporate Marketing (Excel).", action_by: "Ann Lee <ann@corp.com>", action_timestamp: AT };
      const [entry] = rowsToEntries([old]);
      expect(entry).toMatchObject({ action: "Imported", note: "Imported by Corporate Marketing (Excel)." });
      expect(entry.importType).toBeUndefined();
    });

    it("the import marker only ever goes through the same guarded, append-only INSERT", () => {
      const sql = buildInsertAuditStatement(AUDIT, [base({ action: "Imported", importType: "Historic Load", sourceFile: "x.xlsx" })], ids());
      expect(() => assertAuditWriteStatement(AUDIT, sql)).not.toThrow();
      expect(() => assertCiWriteStatement(sql)).not.toThrow();
      expect(sql).toContain("Bulk Import: Historic Load");
    });
  });
});

describe("competitive rows (ci_main)", () => {
  it("inserts one row with a DATE for created_date, the stored wafer number, is_active TRUE and no modified values", () => {
    const sql = buildInsertRecordStatement(MAIN, "11111111-2222-3333-4444-555555555555", record(), "CI-0502");
    expect(sql.startsWith("INSERT INTO `corp_marketing_dev`.`ci`.`ci_main` (")).toBe(true);
    expect(sql).toContain("'11111111-2222-3333-4444-555555555555'");
    expect(sql).toContain("CAST('2026-10-13' AS DATE)");
    expect(sql).toMatch(/, 300 AS `wafer_size_mm`/); // wafer_size_mm: the approved label stored as the number
    expect(sql).not.toContain("300mm");
    expect(sql).toContain("TRUE");
    expect(sql).not.toContain("TIMESTAMP"); // modified_date is NULL on create
    expect(() => assertRecordWriteStatement(MAIN, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("numbers Application IDs CI-0001, CI-0002, ...: the highest stored number + 1, growing past four digits", () => {
    expect(applicationIdFor(501)).toBe("CI-0502");
    expect(applicationIdFor("501")).toBe("CI-0502");
    expect(applicationIdFor(null)).toBe("CI-0001");
    expect(applicationIdFor(9999)).toBe("CI-10000");
    const max = buildMaxApplicationSeqStatement(MAIN);
    expect(max).toContain("RLIKE '^CI-[0-9]+$'");
    expect(max).not.toContain("is_active"); // every row, live or not, so a number is never reused
    expect(() => assertReadOnlyStatement(max)).not.toThrow();
  });

  it("writes the Application ID only if no row already has it, in one guarded statement", () => {
    const sql = buildInsertRecordStatement(MAIN, "x", record(), "CI-0502");
    expect(sql).toContain("'CI-0502' AS `application_id`");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM `corp_marketing_dev`.`ci`.`ci_main` WHERE `application_id` = 'CI-0502')");
    expect(() => assertRecordWriteStatement(MAIN, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("retries with the next number when another create took it first, and gives up after five attempts", async () => {
    const written: string[] = [];
    let seq = 501;
    // The first attempt's number is taken by someone else just before our insert: our NOT EXISTS inserts nothing, the winner's row
    // raises the maximum, and the second attempt (the next number) lands.
    const store = createRecordStore(MAIN, {
      query: async (sql) => (sql.includes("maxSeq") ? [{ maxSeq: String(seq) }] : [{ cnt: written.length >= 2 ? "1" : "0" }]),
      execute: async (sql) => {
        written.push(sql);
        if (written.length === 1) seq += 1;
      },
      newId: () => "new-uuid",
    });
    await store.createRecord(record());
    expect(written).toHaveLength(2);
    expect(written[0]).toContain("'CI-0502' AS `application_id`");
    expect(written[1]).toContain("'CI-0503' AS `application_id`");

    const never = createRecordStore(MAIN, { query: async (sql) => (sql.includes("maxSeq") ? [{ maxSeq: "1" }] : [{ cnt: "0" }]), execute: vi.fn(async () => {}), newId: () => "x" });
    await expect(never.createRecord(record())).rejects.toThrow(/Could not get a free Application ID after 5 attempts/);
  });

  it("stores a blank optional value as NULL and refuses a wafer size or year it cannot store", () => {
    expect(buildInsertRecordStatement(MAIN, "x", record({ films: "", waferSize: "" }), "CI-0001")).toContain("NULL");
    expect(() => buildInsertRecordStatement(MAIN, "x", record({ waferSize: "450mm" }), "CI-0001")).toThrow(ValidationError);
    const refused = (() => {
      try {
        buildInsertRecordStatement(MAIN, "x", record({ waferSize: "100" }), "CI-0001");
        return null;
      } catch (e) {
        return e as ValidationError;
      }
    })();
    // The message names the exact approved labels, so a person can see what to put in the list.
    expect((refused?.details ?? []).join(" ")).toContain('Wafer Size "100" is not one of the approved sizes: 150mm (6"), 200mm (8"), 300mm (12")');
    // The same approved sizes written more simply are stored as the number.
    for (const spelling of ["300mm", "300", "300 mm"]) expect(buildInsertRecordStatement(MAIN, "x", record({ waferSize: spelling }), "CI-0001")).toMatch(/, 300 AS `wafer_size_mm`/);
    expect(() => buildInsertRecordStatement(MAIN, "x", record({ year: "20x6" }), "CI-0001")).toThrow(ValidationError);
    expect(() => buildInsertRecordStatement(MAIN, "x", record({ createdOn: "13/10/2026" }), "CI-0001")).toThrow(/Invalid date/);
  });

  it("updates one live row by id, never touching the id or the created-once columns", () => {
    const sql = buildUpdateRecordStatement(MAIN, { ...record(), recordId: "r1", modifiedBy: "Bob Ray", modifiedOn: AT });
    expect(sql.startsWith("UPDATE `corp_marketing_dev`.`ci`.`ci_main` SET")).toBe(true);
    const set = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf(" WHERE "));
    for (const forbidden of ["`ci_id`", "`created_by`", "`created_date`"]) expect(set).not.toContain(forbidden);
    expect(set).toContain("`modified_by` = 'Bob Ray'");
    expect(set).toContain("`modified_date` = CAST('2026-10-13T10:00:00.000Z' AS TIMESTAMP)");
    expect(sql).toMatch(/WHERE `ci_id` = 'r1' AND `is_active` = TRUE$/);
    expect(() => assertRecordWriteStatement(MAIN, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("undoing a create only sets is_active to FALSE; nothing is deleted", () => {
    const sql = buildDiscardRecordStatement(MAIN, "r1");
    expect(sql).toBe("UPDATE `corp_marketing_dev`.`ci`.`ci_main` SET `is_active` = FALSE WHERE `ci_id` = 'r1'");
    expect(() => assertRecordWriteStatement(MAIN, sql)).not.toThrow();
  });

  it("refuses any other statement for the table", () => {
    for (const bad of [`DELETE FROM ${MAIN}`, "UPDATE corp_marketing_dev.ci.ci_lookup SET a = 1", `UPDATE \`corp_marketing_dev\`.\`ci\`.\`ci_main\` SET a = 1; DROP TABLE x`, `MERGE INTO ${MAIN} AS t USING (SELECT 1) AS s ON 1=1`]) {
      expect(() => assertRecordWriteStatement(MAIN, bad)).toThrow(/Refused/);
    }
  });

  it("reads only live rows, and applies a Sales scope in the WHERE clause", () => {
    const all = buildListRecordsStatement(MAIN, FULL_SCOPE);
    expect(all).toContain("WHERE `is_active` = TRUE ORDER BY");
    expect(all).not.toContain(" IN (");
    expect(() => assertReadOnlyStatement(all)).not.toThrow();
    const scoped = buildListRecordsStatement(MAIN, { customers: ["UMC"], segments: ["Foundry", "Logic"], regions: "All" });
    expect(scoped).toContain("`customer` IN ('UMC')");
    expect(scoped).toContain("`served_market` IN ('Foundry', 'Logic')");
    expect(scoped).not.toContain("`fab_region` IN");
    expect(buildGetRecordsStatement(MAIN, ["a", "b"])).toContain("`ci_id` IN ('a', 'b')");
  });

  it("creates with a new id, returns the saved row, and sends only guarded statements", async () => {
    const execute = vi.fn(async () => {});
    const store = createRecordStore(MAIN, { query: async (sql) => (sql.includes("maxSeq") ? [{ maxSeq: "501" }] : sql.includes("cnt") ? [{ cnt: "1" }] : []), execute, newId: () => "new-uuid" });
    const created = await store.createRecord(record());
    expect(created.recordId).toBe("new-uuid");
    expect(created.customer).toBe("UMC");
    await store.updateRecord({ ...created, customer: "TSMC" });
    await store.discardRecord("new-uuid");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await store.getRecords([])).toEqual([]);
  });

  it("reads a stored row back as the app's record (wafer label, text and numbers)", async () => {
    const row = { ci_id: "r1", quarter: "Q1", year: 2026, customer: "UMC", fab_location: "F", fab_region: "Taiwan", served_market: "Foundry", technology_node: "28nm", wafer_size_mm: "300.0", actual_order: "2", asp_million: "1.5", revenue_sales_currency: "3", created_by: "Ann Lee", created_date: "2026-10-13", modified_by: null, modified_date: null, is_active: true };
    const store = createRecordStore(MAIN, { query: async () => [row], execute: async () => {}, newId: () => "x" });
    const [r] = await store.listRecords(FULL_SCOPE);
    expect(r).toMatchObject({ recordId: "r1", year: "2026", waferSize: '300mm (12")', actualOrder: 2, asp: 1.5, revenue: 3, createdOn: "2026-10-13", createdBy: "Ann Lee" });
    expect(r.modifiedBy).toBeUndefined();
    expect((await store.getRecord("r1"))?.recordId).toBe("r1");
  });
});

describe("repository wiring", () => {
  const raw = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
    id: "u", userName: "U", email: "u@x.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All", status: "Active", lastSignIn: "", isActive: true, ...over,
  });

  it("turns the valid, active user records into the app's users and leaves invalid ones out", () => {
    const users = usersFromRecords([
      raw({ id: "a", email: "cm@x.com", userName: "CM" }),
      raw({ id: "b", email: "at@x.com", role: "Account Team", customer: '["UMC"]', segment: "All", region: '["TWN"]' }),
      raw({ id: "c", email: "off@x.com", isActive: false, status: "Off-boarded" }),
      raw({ id: "d", email: "bad@x.com", role: "Account Team", customer: "UMC,TSMC" }),
    ]);
    expect(users.map((u) => [u.id, u.role, u.customerScope, u.regionScope])).toEqual([["a", "CM", "All", "All"], ["b", "Sales", ["UMC"], ["TWN"]]]);
  });

  it("routes notes, audit, rows and users to their stores, and keeps everything else refusing", async () => {
    const addNotes = vi.fn(async () => {});
    const addAudit = vi.fn(async () => {});
    const discard = vi.fn(async () => {});
    const repo = composeRepository(createRefusingRepository(), null, {
      notes: { list: async (id) => [{ id: "n", recordId: id, actionTakenBy: "A", dateTime: AT, notes: "x" }], add: addNotes },
      audit: { list: async (entity, id) => [{ id: "a", recordId: `${entity}:${id}`, action: "Edited", actionTakenBy: "A", dateTime: AT, changes: [], note: "" }], add: addAudit },
      records: {
        listRecords: async () => [], getRecord: async () => null, getRecords: async () => [], updateRecord: async () => {},
        createRecord: async (r) => ({ ...r, recordId: "new" }), discardRecord: discard,
      },
      users: { list: async () => [raw({ email: "cm@x.com", userName: "CM" })] },
    });

    await repo.addNotes([{ recordId: "r1", actionTakenBy: "Ann Lee", dateTime: AT, notes: "hello" }]);
    expect(addNotes).toHaveBeenCalledWith([{ recordId: "r1", actionTakenBy: "Ann Lee", dateTime: AT, notes: "hello" }]);

    await repo.addAudit([{ recordId: "r1", action: "Created", actionTakenBy: "Ann Lee", actorEmail: "ann@corp.com", dateTime: AT, changes: [{ field: "customer", label: "Customer", previous: "", current: "UMC" }], note: "why" }]);
    expect(addAudit).toHaveBeenCalledWith([
      { entity: "Competitive Info", recordId: "r1", action: "Created", changes: [{ field: "customer", label: "Customer", previous: "", current: "UMC" }], note: "why", actionByName: "Ann Lee", actionByEmail: "ann@corp.com", at: AT },
    ]);
    // An Import's type and file reach the audit store (they are not dropped on the way).
    addAudit.mockClear();
    await repo.addAudit([{ recordId: "r2", action: "Imported", actionTakenBy: "Ann Lee", dateTime: AT, changes: [], note: "n", importType: "Excel Import", sourceFile: "f.xlsx" }]);
    expect(addAudit).toHaveBeenCalledWith([expect.objectContaining({ recordId: "r2", action: "Imported", importType: "Excel Import", sourceFile: "f.xlsx" })]);
    expect((await repo.listAudit("r1"))[0].recordId).toBe("Competitive Info:r1");
    expect((await repo.listNotes("r1"))[0].recordId).toBe("r1");
    expect((await repo.createRecord(record())).recordId).toBe("new");
    await repo.discardRecord("new");
    expect(discard).toHaveBeenCalledWith("new");

    expect((await repo.findUserByEmail(" CM@X.com "))?.name).toBe("CM");
    expect(await repo.findUserByEmail("nobody@x.com")).toBeNull();
    expect((await repo.getUser("u"))?.email).toBe("cm@x.com");

    // Not connected yet: still refuses.
    await expect(repo.createRecords([])).rejects.toThrow(/not been implemented|pending/);
    await expect(repo.createUser({ name: "x", email: "x@x.com", role: "Sales", customerScope: "All", segmentScope: "All", regionScope: "All", status: "Active" })).rejects.toThrow();
  });
});
