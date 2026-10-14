import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { CI_TABLE_LABELS, CI_TABLES, LOGIN_HISTORY_COLUMNS, assertLoginHistoryColumns, ciTableName, type CiTableKey, type CiTables, type LoginHistoryColumns } from "@/server/db/schema";
import { assertCiWriteStatement } from "@/server/db/write-guard";
import { CiError, DisabledError, ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import {
  assertLoginHistoryWriteStatement,
  buildInsertStatement,
  buildListStatement,
  newLoginRow,
  rowToLoginRecord,
  type LoginHistoryTarget,
} from "@/server/ci/login-history/data";
import { createLoginHistoryRepository, resolveLoginHistoryTarget, type LoginHistoryDeps } from "@/server/ci/login-history/repository";
import { listLoginHistory, type LoginHistoryServiceDeps } from "@/server/ci/login-history/service";
import { STANDALONE_REQUIRES, pendingRequiredTables, requireTablesConfigured } from "@/server/ci/readiness";

// Isolated tests only. The table and column names below are FAKE test values that
// only exercise the builders — they are not CI's real table. Nothing here opens a
// Databricks connection: the database, clock, ids and authorization are fakes.

const T = "`test_catalog`.`test_schema`.`test_login_history`";
const columns: LoginHistoryColumns = { id: "c_id", email: "c_email", name: "c_name", loginTime: "c_time" };
const target: LoginHistoryTarget = { table: "test_catalog.test_schema.test_login_history", columns };

const NOW = "2026-10-11T09:00:00.000Z";
const NOW_SQL = "CAST('2026-10-11T09:00:00.000Z' AS TIMESTAMP)";
const KEYS = Object.keys(CI_TABLE_LABELS) as CiTableKey[];
const allPending = Object.fromEntries(KEYS.map((k) => [k, null])) as CiTables;
const withTable = { ...allPending, loginHistory: { catalog: "c", schema: "s", table: "t" } } as CiTables;

function makeRepoDeps(over: Partial<LoginHistoryDeps> = {}) {
  const query = vi.fn<LoginHistoryDeps["query"]>(async () => []);
  const execute = vi.fn<LoginHistoryDeps["execute"]>(async () => {});
  const deps: LoginHistoryDeps = {
    now: () => NOW,
    newId: () => "lr-test-1",
    connected: () => true,
    ...over,
    query: (over.query as LoginHistoryDeps["query"]) ?? query,
    execute: (over.execute as LoginHistoryDeps["execute"]) ?? execute,
  };
  return { deps, query: deps.query as typeof query, execute: deps.execute as typeof execute };
}

describe("schema slot", () => {
  it("has a label, and validates a configured column mapping", () => {
    expect(CI_TABLE_LABELS.loginHistory).toBe("Login History");
    expect(() => assertLoginHistoryColumns(null)).not.toThrow();
    expect(() => assertLoginHistoryColumns(columns)).not.toThrow();
    expect(() => assertLoginHistoryColumns({ ...columns, email: "x; DROP TABLE t" })).toThrow(/Invalid SQL identifier/);
  });

  it("is configured to corp_marketing_dev.audit.ci_login_history with exactly that table's own columns", () => {
    expect(ciTableName("loginHistory", CI_TABLES)).toBe("corp_marketing_dev.audit.ci_login_history");
    expect(LOGIN_HISTORY_COLUMNS).toEqual({
      id: "login_id", email: "user_email", name: "user_name", loginTime: "login_timestamp", role: "role_name", event: "event_type",
      result: "result", device: "device_info", ipAddress: "ip_address", note: "note", createdOn: "created_on",
    });
    expect(() => assertLoginHistoryColumns(LOGIN_HISTORY_COLUMNS)).not.toThrow();
    expect(resolveLoginHistoryTarget()).toEqual({ table: "corp_marketing_dev.audit.ci_login_history", columns: LOGIN_HISTORY_COLUMNS });
  });
});

describe("SQL builders", () => {
  it("lists every row with an email, newest first, selecting only the four mapped columns", () => {
    const sql = buildListStatement(target).replace(/\s+/g, " ");
    expect(sql).toBe(
      `SELECT \`c_id\`, \`c_name\`, \`c_email\`, \`c_time\` FROM ${T} WHERE \`c_email\` IS NOT NULL AND \`c_email\` <> '' ORDER BY \`c_time\` DESC`
    );
    expect(sql).not.toContain("*");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("builds the one row recorded for a sign-in, using the mapped column names", () => {
    const row = newLoginRow(target, { id: "lr-1", email: " ann@example.com ", name: " Ann Lee ", now: NOW });
    expect(row).toMatchObject({ c_id: "lr-1", c_email: "ann@example.com", c_name: "Ann Lee" });
    expect((row.c_time as { sql: string }).sql).toBe(NOW_SQL); // an explicit TIMESTAMP cast, never an implicit string conversion
    expect(Object.keys(row)).toEqual(["c_id", "c_email", "c_name", "c_time"]);
    expect(newLoginRow(target, { id: "lr-2", email: "bob@example.com", name: "  ", now: NOW })).toMatchObject({ c_name: "bob@example.com" });
  });

  it("appends with a single INSERT, and the guard accepts only that (never an update, delete or merge)", () => {
    const sql = buildInsertStatement(target, newLoginRow(target, { id: "lr-1", email: "ann@example.com", name: "Ann", now: NOW }));
    expect(sql.startsWith(`INSERT INTO ${T} (`)).toBe(true);
    expect(sql).not.toMatch(/MERGE|UPDATE|DELETE/);
    expect(sql).toContain(NOW_SQL);
    expect(() => assertLoginHistoryWriteStatement(target, sql)).not.toThrow();
    for (const bad of [
      `UPDATE ${T} SET \`c_email\` = 'x'`,
      `DELETE FROM ${T}`,
      `DROP TABLE ${T}`,
      `MERGE INTO ${T} AS t USING (SELECT 1) AS s ON 1=1`,
      "INSERT INTO `other`.`table`.`x` (a) VALUES (1)",
      `${sql}; DELETE FROM ${T}`,
    ]) {
      expect(() => assertLoginHistoryWriteStatement(target, bad)).toThrow(/Refused/);
    }
  });

  it("a quote in a name cannot break out of the statement", () => {
    const sql = buildInsertStatement(target, newLoginRow(target, { id: "lr-1", email: "a@example.com", name: "x'); DROP TABLE t; --", now: NOW }));
    expect(() => assertLoginHistoryWriteStatement(target, sql)).not.toThrow();
    expect(sql).toContain("'x''); DROP TABLE t; --'");
  });

  it("maps a row, trimming values and blanking an unusable date", () => {
    expect(rowToLoginRecord(target, { c_id: " lr-1 ", c_email: " ann@example.com ", c_name: null, c_time: "2026-09-08T23:37:00Z" })).toEqual({
      id: "lr-1",
      email: "ann@example.com",
      name: "",
      loginTime: "2026-09-08T23:37:00.000Z",
    });
    expect(rowToLoginRecord(target, { c_time: "not a date" }).loginTime).toBe("");
  });
});

describe("optional columns and the own-history filter", () => {
  const full: LoginHistoryTarget = {
    table: target.table,
    columns: { ...columns, role: "c_role", event: "c_event", result: "c_result", device: "c_device", ipAddress: "c_ip", note: "c_note", createdOn: "c_created" },
  };

  it("selects, maps and writes ONLY the optional columns the table has", () => {
    const plain = buildListStatement(target).replace(/\s+/g, " ");
    expect(plain).not.toContain("c_event");
    const sql = buildListStatement(full).replace(/\s+/g, " ");
    for (const c of ["c_role", "c_event", "c_result", "c_device", "c_ip", "c_note"]) expect(sql).toContain(`\`${c}\``);
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();

    const record = rowToLoginRecord(full, { c_id: "1", c_email: "a@example.com", c_name: "A", c_time: "2026-10-11T08:00:00Z", c_event: "Signed in", c_result: "Success" });
    expect(record).toMatchObject({ event: "Signed in", result: "Success", role: "", device: "" });
    expect(rowToLoginRecord(target, { c_id: "1" })).not.toHaveProperty("event");

    // Only successful sign-ins are recorded: the event is always "Signed in" and the result "Success".
    const written = newLoginRow(full, { id: "x", email: "a@example.com", name: "A", now: NOW, role: "Corporate Marketing" });
    expect(written).toMatchObject({ c_event: "Signed in", c_result: "Success", c_role: "Corporate Marketing" });
    expect((written.c_created as { sql: string }).sql).toBe(NOW_SQL); // created_on carries the same time as the sign-in
    expect(written).not.toHaveProperty("c_device");
    expect(written).not.toHaveProperty("c_ip");
    expect(written).not.toHaveProperty("c_note");
    expect(newLoginRow(full, { id: "x", email: "a@example.com", name: "A", now: NOW })).not.toHaveProperty("c_role"); // no CI record -> no role
    expect(newLoginRow(target, { id: "x", email: "a@example.com", name: "A", now: NOW })).not.toHaveProperty("c_event");
  });

  it("limits the list to one person's own rows, escaping the email", () => {
    const sql = buildListStatement(target, { email: " Ann@Example.com " }).replace(/\s+/g, " ");
    expect(sql).toContain("AND LOWER(`c_email`) = 'ann@example.com' ORDER BY");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    const tricky = buildListStatement(target, { email: "x'; DROP TABLE t; --" });
    expect(tricky).toContain("'x''; drop table t; --'");
  });

  it("validates optional column names as identifiers", () => {
    expect(() => assertLoginHistoryColumns({ ...columns, event: "c_event" })).not.toThrow();
    expect(() => assertLoginHistoryColumns({ ...columns, event: "bad name" })).toThrow(/Invalid SQL identifier/);
  });
});

describe("target resolution", () => {
  it("stays unresolved until BOTH the table and the column mapping are configured", () => {
    expect(resolveLoginHistoryTarget(allPending, null)).toBeNull();
    expect(resolveLoginHistoryTarget(allPending, columns)).toBeNull();
    expect(resolveLoginHistoryTarget(withTable, null)).toBeNull();
    expect(resolveLoginHistoryTarget(withTable, columns)).toEqual({ table: "c.s.t", columns });
  });
});

describe("repository while the CI table is pending", () => {
  it("refuses to list with the standard pending message, and records nothing", async () => {
    const repo = createLoginHistoryRepository(null, makeRepoDeps().deps, allPending);
    const error = await repo.list().catch((e) => e);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as NotConfiguredError).message).toBe("CI database table configuration is pending: Login History.");
    expect((error as NotConfiguredError).details).toEqual(["Login History"]);
    await expect(repo.record("ann@example.com", "Ann")).resolves.toBeUndefined();
  });

  it("says the column mapping is what is missing when the table itself is named", async () => {
    const repo = createLoginHistoryRepository(null, makeRepoDeps().deps, withTable);
    await expect(repo.list()).rejects.toThrow("CI database table configuration is pending: Login History (column mapping).");
  });

  it("never touches the database while pending", async () => {
    const { deps, query, execute } = makeRepoDeps();
    const repo = createLoginHistoryRepository(null, deps, allPending);
    await repo.list().catch(() => {});
    await repo.record("ann@example.com", "Ann");
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("repository once configured (fake database)", () => {
  it("lists and maps the rows the query returns", async () => {
    const { deps } = makeRepoDeps({
      query: vi.fn(async () => [{ c_id: "lr-1", c_email: "ann@example.com", c_name: "Ann", c_time: "2026-10-11T08:00:00Z" }]),
    });
    const records = await createLoginHistoryRepository(target, deps).list();
    expect(records).toEqual([{ id: "lr-1", email: "ann@example.com", name: "Ann", loginTime: "2026-10-11T08:00:00.000Z" }]);
    expect(() => assertReadOnlyStatement(vi.mocked(deps.query).mock.calls[0][0])).not.toThrow();
  });

  it("records one sign-in as exactly one INSERT", async () => {
    const { deps, execute } = makeRepoDeps();
    await createLoginHistoryRepository(target, deps).record(" ann@example.com ", " Ann Lee ");
    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0][0];
    expect(statement.startsWith(`INSERT INTO ${T} (`)).toBe(true);
    expect(statement).toContain("'lr-test-1'");
    expect(statement).toContain("'ann@example.com'");
    expect(statement).toContain("'Ann Lee'");
    expect(statement).toContain(NOW_SQL);
  });

  it("the real table's insert passes both write guards and carries the event, result, role and created_on", async () => {
    const real = resolveLoginHistoryTarget()!;
    const { deps, execute } = makeRepoDeps();
    await createLoginHistoryRepository(real, deps).record("ann@example.com", "Ann Lee", { role: "Account Team" });
    const statement = execute.mock.calls[0][0];
    expect(() => assertLoginHistoryWriteStatement(real, statement)).not.toThrow();
    expect(() => assertCiWriteStatement(statement)).not.toThrow();
    for (const part of ["INSERT INTO `corp_marketing_dev`.`audit`.`ci_login_history`", "'Signed in'", "'Success'", "'Account Team'", "`created_on`", "`login_timestamp`"]) expect(statement).toContain(part);
    expect(statement).not.toContain("device_info");
    expect(statement).not.toContain("ip_address");
  });

  it("skips a blank email and skips when Databricks is not connected", async () => {
    const a = makeRepoDeps();
    await createLoginHistoryRepository(target, a.deps).record("   ", "Nobody");
    expect(a.execute).not.toHaveBeenCalled();
    const b = makeRepoDeps({ connected: () => false });
    await createLoginHistoryRepository(target, b.deps).record("ann@example.com", "Ann");
    expect(b.execute).not.toHaveBeenCalled();
  });

  it("never throws when the write fails (a sign-in must never be blocked)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeRepoDeps({
      execute: vi.fn(async () => {
        throw new Error("PERMISSION_DENIED");
      }),
    });
    await expect(createLoginHistoryRepository(target, deps).record("ann@example.com", "Ann")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("listLoginHistory service", () => {
  const identity = { email: "admin@example.com", name: "Admin Person" };
  function makeService(over: Partial<LoginHistoryServiceDeps> = {}) {
    const list = vi.fn(async () => [{ id: "lr-1", email: "ann@example.com", name: "Ann", loginTime: "2026-10-11T08:00:00.000Z" }]);
    const authorize = vi.fn(async () => ({ email: "admin@example.com", userName: "Admin Person" }));
    const deps: LoginHistoryServiceDeps = {
      requireTables: vi.fn(),
      requireConnected: vi.fn(),
      authorize,
      repository: () => ({ list, optionalColumns: () => [], record: async () => {} }),
      ...over,
    };
    return { deps, list, authorize };
  }

  it("returns the records when everything is in place", async () => {
    const { deps } = makeService();
    expect((await listLoginHistory(identity, deps)).records).toHaveLength(1);
  });

  it("reports a pending table before authorizing or reading anything", async () => {
    const { deps, list, authorize } = makeService({
      requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.loginHistoryView, allPending),
    });
    const error = await listLoginHistory(identity, deps).catch((e) => e);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as NotConfiguredError).message).toBe("CI database table configuration is pending: Login History.");
    expect(authorize).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("does not read when Databricks is not connected", async () => {
    const { deps, list } = makeService({
      requireConnected: () => {
        throw new DisabledError("Databricks is not connected on this server.");
      },
    });
    await expect(listLoginHistory(identity, deps)).rejects.toBeInstanceOf(DisabledError);
    expect(list).not.toHaveBeenCalled();
  });

  it("gives Corporate Marketing everyone's sign-ins", async () => {
    const { deps, list } = makeService();
    const result = await listLoginHistory(identity, deps);
    expect(result.scope).toBe("all");
    expect(list).toHaveBeenCalledWith(undefined);
  });

  it("limits anyone else to their own sign-ins, using the verified session email", async () => {
    const { deps, list } = makeService({
      authorize: vi.fn(async () => {
        throw new ForbiddenError("Only Corporate Marketing users can add, edit or delete users.");
      }),
    });
    const result = await listLoginHistory({ email: "sam@example.com", name: "Sam" }, deps);
    expect(result.scope).toBe("own");
    expect(list).toHaveBeenCalledWith({ email: "sam@example.com" });
  });

  it("still fails (not widens) when the authorization check itself breaks", async () => {
    const { deps, list } = makeService({
      authorize: vi.fn(async () => {
        throw new Error("warehouse unreachable");
      }),
    });
    await expect(listLoginHistory(identity, deps)).rejects.toThrow("warehouse unreachable");
    expect(list).not.toHaveBeenCalled();
  });

  it("hides the database's own error text, but passes expected safe errors through", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = makeService({
      repository: () => ({
        list: async () => {
          throw new Error("PERMISSION_DENIED for token dapiSECRET");
        },
        optionalColumns: () => [],
        record: async () => {},
      }),
    });
    const hidden = await listLoginHistory(identity, unknown.deps).catch((e) => e);
    expect(hidden).toBeInstanceOf(CiError);
    expect((hidden as CiError).message).not.toMatch(/PERMISSION_DENIED|dapiSECRET/);
    expect((hidden as CiError).status).toBe(502);

    const safe = makeService({
      repository: () => ({
        list: async () => {
          throw new NotConfiguredError(["Login History"]);
        },
        optionalColumns: () => [],
        record: async () => {},
      }),
    });
    await expect(listLoginHistory(identity, safe.deps)).rejects.toBeInstanceOf(NotConfiguredError);
    spy.mockRestore();
  });
});

describe("readiness", () => {
  it("counts Login History among the tables still pending", () => {
    expect(STANDALONE_REQUIRES.loginHistoryView).toEqual(["loginHistory"]);
    expect(pendingRequiredTables(allPending)).toContain("Login History");
    expect(pendingRequiredTables(withTable)).not.toContain("Login History");
    expect(pendingRequiredTables(CI_TABLES)).not.toContain("Login History"); // configured now
  });
});
