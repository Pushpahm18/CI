import { describe, expect, it } from "vitest";
import { buildHistoricPreview } from "@/lib/ci/import/historic";
import { HISTORIC_COLUMNS } from "@/lib/ci/import/historic-config";
import { parseAmount, parseIsoDate } from "@/lib/ci/import/parse-values";
import { TEST_OPTIONS, TEST_USERS } from "@/lib/ci/import/test-fixtures";
import type { HistoricOptions, ParsedSheet } from "@/lib/ci/import/types";

type Row = Partial<Record<(typeof HISTORIC_COLUMNS)[number] | "Currency", string>>;

const VALID: Row = {
  Quarter: "Q1",
  Year: "2021",
  Customer: "Samsung",
  "Fab Location": "Samsung Hwaseong",
  "Served Market": "Foundry",
  "Technology Node": "L5",
  "Wafer Size (mm)": '300mm (12")',
  "Process Application": "DPT",
  "Process Type": "Sacrificial - Conformal",
  "Process Location": "FEOL",
  "Film(s)": "SiO",
  "Top Competitor": "AMAT",
  "Product Line": "PEALD",
  "Product Name": "Producer",
  "Process Modules": "2",
  "Actual Order (#)": "7",
  "ASP (Euro)": "2300000",
  "Revenue (Euro)": "2500000",
  Notes: "Competitor information from regional historical file",
  "Created By": "Shruti Mehta",
  Date: "2021-05-28",
  Tooltype: "SiO-QCM",
};

const ctx = { ...TEST_OPTIONS, users: TEST_USERS, today: "2026-10-06" };
const defaults: HistoricOptions = { loadNotCompetitor: true, mappingOverrides: {} };

function sheet(rows: Row[], extraHeaders: string[] = []): ParsedSheet {
  const headers = [...HISTORIC_COLUMNS, ...extraHeaders];
  return { fileName: "kor.xlsx", headers, rows: rows.map((r) => headers.map((h) => r[h as keyof Row] ?? "")) };
}

const preview = (rows: Row[], options = defaults, extra?: string[]) => buildHistoricPreview(sheet(rows, extra), ctx, options);

describe("historic load — valid row", () => {
  const p = preview([VALID]);
  const row = p.rows[0];
  it("is ready and commit is allowed", () => {
    expect(row.status).toBe("ready");
    expect(p.canCommit).toBe(true);
    expect(p.summary.inserts).toBe(1);
  });
  it("converts Euro amounts to millions and keeps Currency = EUR", () => {
    expect(row.record?.revenue).toBe(2.5);
    expect(row.record?.asp).toBe(2.3);
    expect(row.record?.currency).toBe("EUR");
  });
  it("preserves source Revenue instead of recalculating Actual Order × ASP", () => {
    expect(row.record?.revenue).not.toBe(7 * 2.3);
  });
  it("derives Fab Region from the fab master", () => {
    expect(row.record?.fabRegion).toBe("Korea");
  });
  it("leaves Order Type blank", () => {
    expect(row.record?.orderType).toBe("");
  });
  it("uses the old Notes as the first Change Note", () => {
    expect(row.changeNote).toBe("Competitor information from regional historical file");
  });
  it("matches Created By to a CI user", () => {
    expect(row.record?.createdBy).toBe("Shruti Mehta");
  });
});

describe("historic load — other currencies are unit-converted only", () => {
  it("USD 5,000,000 → 5 USD when the file has a Currency column", () => {
    const row = preview([{ ...VALID, Currency: "USD", "Revenue (Euro)": "5000000" }], defaults, ["Currency"]).rows[0];
    expect(row.record?.revenue).toBe(5);
    expect(row.record?.currency).toBe("USD");
  });
  it("a currency outside the CI list (GBP) is a blocking error, not converted", () => {
    const row = preview([{ ...VALID, Currency: "GBP" }], defaults, ["Currency"]).rows[0];
    expect(row.status).toBe("held");
    expect(row.issues.some((i) => i.field === "Currency" && i.severity === "error")).toBe(true);
  });
});

describe("historic load — skipped, flagged and blocked rows", () => {
  it("skips completely empty rows and counts them", () => {
    const p = preview([VALID, {}]);
    expect(p.summary.emptySkipped).toBe(1);
    expect(p.rows[1].status).toBe("empty");
    expect(p.canCommit).toBe(true);
  });
  it("loads 'Not competitor…' rows flagged, keeping the note", () => {
    const row = preview([{ ...VALID, Notes: "Not competitor anymore" }]).rows[0];
    expect(row.status).toBe("flagged");
    expect(row.changeNote).toBe("Not competitor anymore");
  });
  it("does not load 'Not competitor…' rows when the option is off", () => {
    const row = preview([{ ...VALID, Notes: "Not competitor anymore" }], { ...defaults, loadNotCompetitor: false }).rows[0];
    expect(row.status).toBe("not-loaded");
  });
  it("holds an unknown Customer and blocks the whole load", () => {
    const p = preview([VALID, { ...VALID, Customer: "ABC Corp" }]);
    expect(p.rows[1].status).toBe("held");
    expect(p.canCommit).toBe(false);
  });
  it("a user mapping fixes an unknown value", () => {
    const p = preview([{ ...VALID, Customer: "Samsung Elec" }], { ...defaults, mappingOverrides: { "customer|Samsung Elec": "Samsung" } });
    expect(p.rows[0].status).toBe("ready");
    expect(p.rows[0].record?.customer).toBe("Samsung");
  });
  it("cleans spelling/spacing variants (SK hynix → SK Hynix, D1z → D1Z)", () => {
    const row = preview([
      { ...VALID, Customer: "SK hynix", "Fab Location": "SK Hynix Icheon", "Served Market": "DRAM ", "Technology Node": "D1z", "Process Location": "BEOL" },
    ]).rows[0];
    expect(row.status).toBe("ready");
    expect(row.record?.customer).toBe("SK Hynix");
    expect(row.record?.technologyNode).toBe("D1Z");
  });
  it("suggests known competitor variants but asks for confirmation", () => {
    const p = preview([{ ...VALID, "Top Competitor": "IPS" }]);
    expect(p.rows[0].record?.topCompetitor).toBe("Wonik IPS");
    expect(p.mappings.find((m) => m.source === "IPS")?.status).toBe("suggested");
    expect(p.rows[0].issues.some((i) => i.severity === "warning")).toBe(true);
  });
  it("a fab not in the master loads with Fab Region blank (warning)", () => {
    const row = preview([{ ...VALID, "Fab Location": "P2L" }]).rows[0];
    expect(row.status).toBe("ready");
    expect(row.record?.fabRegion).toBe("");
    expect(row.issues.some((i) => i.field === "Fab Location" && i.severity === "warning")).toBe(true);
  });
  it("blocks a Technology Node not recorded for the Customer + Served Market", () => {
    expect(preview([{ ...VALID, "Technology Node": "N3" }]).rows[0].status).toBe("held");
  });
  it("blocks a Process Location not offered for the Served Market", () => {
    expect(preview([{ ...VALID, "Process Location": "BEOL" }]).rows[0].status).toBe("held");
  });
  it("blocks non-numeric amounts", () => {
    const row = preview([{ ...VALID, "ASP (Euro)": "ABC" }]).rows[0];
    expect(row.status).toBe("held");
    expect(row.issues.some((i) => i.field === "ASP (Euro)" && i.value === "ABC")).toBe(true);
  });
  it("blocks invalid dates", () => {
    expect(preview([{ ...VALID, Date: "2021-02-30" }]).rows[0].status).toBe("held");
  });
  it("warns about duplicate rows", () => {
    const p = preview([VALID, VALID]);
    expect(p.rows[1].issues.some((i) => i.message.startsWith("Duplicate of line 2"))).toBe(true);
  });
  it("rejects a file whose template columns are missing", () => {
    const s: ParsedSheet = { fileName: "x.csv", headers: ["Quarter", "Year"], rows: [["Q1", "2021"]] };
    const p = buildHistoricPreview(s, ctx, defaults);
    expect(p.missingColumns.length).toBeGreaterThan(0);
    expect(p.canCommit).toBe(false);
  });
});

describe("value parsing", () => {
  it("parses amounts with separators and currency symbols", () => {
    expect(parseAmount("2,300,000")).toEqual({ ok: true, value: 2_300_000 });
    expect(parseAmount("€2,500,000")).toEqual({ ok: true, value: 2_500_000 });
    expect(parseAmount("ABC")).toEqual({ ok: false });
  });
  it("validates calendar dates", () => {
    expect(parseIsoDate("2024-06-14")).toBe("2024-06-14");
    expect(parseIsoDate("2021-02-30")).toBeNull();
    expect(parseIsoDate("14/06/2024")).toBeNull();
  });
});
