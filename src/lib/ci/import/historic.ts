import type { CiUser, CompetitiveRecord, FormOptions } from "@/types/ci";
import { FIELD_BY_KEY } from "@/lib/ci/field-spec";
import { blankForm, fabRegionFor, fieldOptions, lookupOptions, type FormState, type UserFieldKey } from "@/lib/ci/rules";
import { convertRevenue, roundTo } from "@/lib/ci/import/currency";
import {
  DEFAULT_HISTORIC_NOTE,
  DEFAULT_WAFER_PATTERN,
  HISTORIC_ASP_DECIMALS,
  HISTORIC_COLUMNS,
  HISTORIC_REVENUE_DECIMALS,
  HISTORIC_RULE_SEVERITY,
  HISTORIC_SOURCE_CURRENCY,
  NOT_COMPETITOR_PATTERN,
  OPTIONAL_CURRENCY_COLUMN,
  PLACEHOLDER_OWNER,
  SUGGESTED_MAPPINGS,
  UNMATCHED_OWNER_SUFFIX,
  type HistoricColumn,
} from "@/lib/ci/import/historic-config";
import {
  headerIndex,
  isBlankRow,
  matchListValue,
  missingHeaders,
  normaliseValue,
  parseAmount,
  parseIsoDate,
  unexpectedHeaders,
} from "@/lib/ci/import/parse-values";
import type {
  HistoricOptions,
  HistoricPreview,
  HistoricPreviewRow,
  ImportIssue,
  IssueSeverity,
  MappedField,
  ParsedSheet,
  ValueMapping,
} from "@/lib/ci/import/types";

/**
 * Historic Load (BRD §7.5, CI Prototype "Historic load (regional files)"):
 * parse → validate → map to CI lists → transform → preview. Pure: the
 * caller supplies lookups/reference data (LookupProvider) and users, and
 * nothing is written here.
 */

export interface HistoricContext extends FormOptions {
  users: CiUser[];
  /** Today's date (yyyy-mm-dd) — used when a row has no Date. */
  today: string;
}

type SourceRow = Record<HistoricColumn, string> & { currency: string };

/** The four fields the CI Prototype maps through its value-mapping table. */
const MAPPED_FIELDS: { field: MappedField; column: HistoricColumn; label: string }[] = [
  { field: "customer", column: "Customer", label: "Customer" },
  { field: "servedMarket", column: "Served Market", label: "Served Market" },
  { field: "processType", column: "Process Type", label: "Process Type" },
  { field: "topCompetitor", column: "Top Competitor", label: "Top Competitor" },
];

function mappingOptions(field: MappedField, ctx: HistoricContext): string[] {
  if (field === "customer") return ctx.reference.customers;
  return lookupOptions(ctx.lookups, FIELD_BY_KEY[field].lookupCategory!);
}

export const mappingKey = (field: MappedField, source: string) => `${field}|${source}`;

/** Resolves one file value to a CI list value: user override, exact/cleaned match, or a suggested variant. */
export function resolveMapping(
  field: MappedField,
  source: string,
  options: string[],
  overrides: Record<string, string>
): { target: string; status: ValueMapping["status"] } {
  const override = overrides[mappingKey(field, source)];
  if (override !== undefined) {
    return override && options.includes(override) ? { target: override, status: "mapped" } : { target: "", status: "unmapped" };
  }
  if (options.includes(source)) return { target: source, status: "exact" };
  const cleaned = matchListValue(source, options);
  if (cleaned) return { target: cleaned, status: "cleaned" };
  const suggested = SUGGESTED_MAPPINGS[normaliseValue(source)];
  if (suggested && options.includes(suggested)) return { target: suggested, status: "suggested" };
  return { target: "", status: "unmapped" };
}

function readRows(sheet: ParsedSheet): { line: number; cells: SourceRow; blank: boolean; raw: string[] }[] {
  const idx = headerIndex(sheet.headers);
  const currencyIdx = idx(OPTIONAL_CURRENCY_COLUMN);
  return sheet.rows.map((raw, i) => {
    const cells = Object.fromEntries(
      HISTORIC_COLUMNS.map((c) => {
        const at = idx(c);
        return [c, at >= 0 ? String(raw[at] ?? "").trim() : ""];
      })
    ) as SourceRow;
    cells.currency = currencyIdx >= 0 ? String(raw[currencyIdx] ?? "").trim() : "";
    return { line: i + 2, cells, blank: isBlankRow(raw), raw };
  });
}

export function buildHistoricPreview(sheet: ParsedSheet, ctx: HistoricContext, options: HistoricOptions): HistoricPreview {
  const missingColumns = missingHeaders(sheet.headers, HISTORIC_COLUMNS);
  const unexpectedColumns = unexpectedHeaders(sheet.headers, [...HISTORIC_COLUMNS, OPTIONAL_CURRENCY_COLUMN]);
  const rows = readRows(sheet);

  // ---- value-mapping table (distinct file values of the four mapped fields)
  const mappings: ValueMapping[] = [];
  for (const m of MAPPED_FIELDS) {
    const opts = mappingOptions(m.field, ctx);
    const distinct = Array.from(new Set(rows.filter((r) => !r.blank && r.cells[m.column]).map((r) => r.cells[m.column])));
    for (const source of distinct) {
      const { target, status } = resolveMapping(m.field, source, opts, options.mappingOverrides);
      mappings.push({ field: m.field, label: m.label, source, target, status, options: opts });
    }
  }
  const mapped = (field: MappedField, source: string) =>
    mappings.find((x) => x.field === field && x.source === source)?.target ?? "";

  const currencies = lookupOptions(ctx.lookups, "Currency");
  const seen = new Map<string, number>();
  const previewRows: HistoricPreviewRow[] = rows.map(({ line, cells, blank, raw }) => {
    const issues: ImportIssue[] = [];
    const add = (field: string, value: string, message: string, severity: IssueSeverity) =>
      issues.push({ row: line, field, value, message, severity });

    if (blank) {
      return { line, status: "empty", changeNote: "", source: { ...cells }, sourceCreatedBy: "", sourceAsp: "", sourceRevenue: "", issues };
    }

    // ---- mapped fields
    const form: FormState = blankForm();
    for (const m of MAPPED_FIELDS) {
      const source = cells[m.column];
      if (!source) {
        add(m.label, source, `${m.label} is empty`, "error");
        continue;
      }
      const target = mapped(m.field, source);
      if (!target) add(m.label, source, `${m.label} “${source}” needs mapping to a CI value`, "error");
      else form[m.field] = target;
      const mapping = mappings.find((x) => x.field === m.field && x.source === source);
      if (mapping?.status === "suggested") add(m.label, source, `Suggested mapping to “${target}” — please confirm`, "warning");
    }

    // ---- required free-text fields
    form.fabLocation = cells["Fab Location"];
    form.processApplication = cells["Process Application"];
    form.films = cells["Film(s)"];
    if (!form.fabLocation) add("Fab Location", "", "Fab Location is empty", "error");
    if (!form.processApplication) add("Process Application", "", "Process Application is empty", "error");

    // ---- flat lists (Quarter, Year, Wafer Size, Product Line, Process Modules, Tool Type)
    const listField = (key: UserFieldKey, column: HistoricColumn, required: boolean) => {
      const source = cells[column];
      const label = FIELD_BY_KEY[key].label;
      if (!source) {
        if (required) add(label, source, `${label} is empty`, "error");
        return;
      }
      const match = matchListValue(source, fieldOptions(key, form, { ...ctx, user: null }));
      if (match) form[key] = match;
      else add(label, source, `${label} “${source}” is not in the CI list`, HISTORIC_RULE_SEVERITY.valueNotInList);
    };
    listField("quarter", "Quarter", true);
    listField("year", "Year", true);
    listField("productLine", "Product Line", true);
    listField("processModules", "Process Modules", true);
    listField("toolType", "Tooltype", true);
    if (cells["Wafer Size (mm)"]) listField("waferSize", "Wafer Size (mm)", true);
    else {
      const def = fieldOptions("waferSize", form, { ...ctx, user: null }).find((v) => DEFAULT_WAFER_PATTERN.test(v));
      if (def) {
        form.waferSize = def;
        add("Wafer Size (mm)", "", `Wafer Size defaulted to ${def}`, "info");
      } else add("Wafer Size (mm)", "", "Wafer Size is empty", "error");
    }

    // ---- relationships (Customer + Served Market → Technology Node; Served Market → Process Location)
    const relation = (key: UserFieldKey, column: HistoricColumn, severity: IssueSeverity, why: string) => {
      const source = cells[column];
      const label = FIELD_BY_KEY[key].label;
      if (!source) return add(label, source, `${label} is empty`, "error");
      if (!form.customer || !form.servedMarket) return; // reported via the mapped fields
      const match = matchListValue(source, fieldOptions(key, form, { ...ctx, user: null }));
      if (match) form[key] = match;
      else add(label, source, `${label} “${source}” is not valid for ${why}`, severity);
    };
    relation("technologyNode", "Technology Node", HISTORIC_RULE_SEVERITY.technologyNodeNotForCustomerMarket, `${form.customer} / ${form.servedMarket}`);
    relation("processLocation", "Process Location", HISTORIC_RULE_SEVERITY.processLocationNotForMarket, form.servedMarket);

    // ---- Top Competitor → Product Name (CI Prototype: Product Name is a cascade of the competitor)
    const productSource = cells["Product Name"];
    if (!productSource) add("Product Name", productSource, "Product Name is empty", "error");
    else if (form.topCompetitor) {
      const match = matchListValue(productSource, fieldOptions("productName", form, { ...ctx, user: null }));
      if (match) form.productName = match;
      else add("Product Name", productSource, `Product Name “${productSource}” is not valid for ${form.topCompetitor}`, HISTORIC_RULE_SEVERITY.productNameNotForCompetitor);
    }

    // ---- Fab Region from the fab master (never typed in)
    let fabRegion = "";
    if (form.customer && form.fabLocation) {
      const fab = matchListValue(
        form.fabLocation,
        ctx.reference.customerFabs.filter((f) => f.customer === form.customer).map((f) => f.fabLocation)
      );
      if (fab) {
        form.fabLocation = fab;
        fabRegion = fabRegionFor(ctx.reference, form.customer, fab);
      } else {
        add("Fab Location", cells["Fab Location"], "Fab not in the fab master — Fab Region will be blank", HISTORIC_RULE_SEVERITY.fabNotInMaster);
      }
    }

    // ---- amounts: full amounts → millions, currency kept (unit conversion only, no FX)
    const currency = cells.currency || HISTORIC_SOURCE_CURRENCY;
    if (!currencies.includes(currency)) add("Currency", currency, `Currency “${currency}” is not in the CI list`, "error");
    const qty = parseAmount(cells["Actual Order (#)"]);
    if (!qty.ok || qty.value <= 0) add("Actual Order (#)", cells["Actual Order (#)"], "Actual Order (#) must be a positive number", "error");
    const asp = parseAmount(cells["ASP (Euro)"]);
    if (!asp.ok || asp.value <= 0) add("ASP (Euro)", cells["ASP (Euro)"], "ASP must be a positive number", "error");
    let aspMillions = 0;
    let revenue = 0;
    if (asp.ok) aspMillions = roundTo(convertRevenue(asp.value, currency).millions, HISTORIC_ASP_DECIMALS);
    if (cells["Revenue (Euro)"]) {
      const rev = parseAmount(cells["Revenue (Euro)"]);
      if (!rev.ok) add("Revenue (Euro)", cells["Revenue (Euro)"], "Revenue must be a number", "error");
      else revenue = roundTo(convertRevenue(rev.value, currency).millions, HISTORIC_REVENUE_DECIMALS);
    } else if (qty.ok && asp.ok) {
      revenue = roundTo(qty.value * aspMillions, HISTORIC_REVENUE_DECIMALS);
      add("Revenue (Euro)", "", "No Revenue in the file — calculated as Actual Order × ASP", "info");
    }

    // ---- date and owner
    let createdOn = ctx.today;
    if (cells.Date) {
      const iso = parseIsoDate(cells.Date);
      if (iso) createdOn = iso;
      else add("Date", cells.Date, "Date must be a valid date (yyyy-mm-dd)", "error");
    } else add("Date", "", "No Date in the file — today's date is used", "info");

    const typedOwner = cells["Created By"];
    const owner = typedOwner ? ctx.users.find((u) => u.name.toLowerCase() === typedOwner.toLowerCase()) : undefined;
    const createdBy = owner ? owner.name : typedOwner ? `${typedOwner}${UNMATCHED_OWNER_SUFFIX}` : PLACEHOLDER_OWNER;
    if (!owner) add("Created By", typedOwner, typedOwner ? "Name not matched to a CI user" : "No Created By — placeholder owner used", "info");

    // ---- duplicate rows within the file
    const dupKey = raw.map((c) => normaliseValue(c)).join("\u0001");
    const firstLine = seen.get(dupKey);
    if (firstLine !== undefined) add("Row", "", `Duplicate of line ${firstLine}`, HISTORIC_RULE_SEVERITY.duplicateRowInFile);
    else seen.set(dupKey, line);

    // ---- outcome
    const note = cells.Notes;
    const notCompetitor = NOT_COMPETITOR_PATTERN.test(note);
    const blocking = issues.some((i) => i.severity === "error");
    let status: HistoricPreviewRow["status"] = blocking ? "held" : "ready";
    if (!blocking && notCompetitor) {
      if (options.loadNotCompetitor) {
        status = "flagged";
        add("Notes", note, "Row noted “Not competitor…” — loaded and flagged; note kept as the Change Note", "warning");
      } else {
        status = "not-loaded";
        add("Notes", note, "Row noted “Not competitor…” — not loaded (option off)", "info");
      }
    }

    const record: Omit<CompetitiveRecord, "recordId"> = {
      quarter: form.quarter,
      year: form.year,
      customer: form.customer,
      fabLocation: form.fabLocation,
      fabRegion,
      servedMarket: form.servedMarket,
      technologyNode: form.technologyNode,
      waferSize: form.waferSize,
      processApplication: form.processApplication,
      processType: form.processType,
      processLocation: form.processLocation,
      films: form.films,
      productLine: form.productLine,
      topCompetitor: form.topCompetitor,
      productName: form.productName,
      processModules: form.processModules,
      orderType: "",
      actualOrder: qty.ok ? qty.value : 0,
      asp: aspMillions,
      currency,
      revenue,
      toolType: form.toolType,
      createdBy,
      createdOn,
    };

    return {
      line,
      status,
      record,
      changeNote: note || DEFAULT_HISTORIC_NOTE,
      source: { ...cells },
      sourceCreatedBy: typedOwner,
      sourceAsp: cells["ASP (Euro)"],
      sourceRevenue: cells["Revenue (Euro)"],
      issues,
    };
  });

  const issues = previewRows.flatMap((r) => r.issues);
  const count = (s: HistoricPreviewRow["status"]) => previewRows.filter((r) => r.status === s).length;
  const summary = {
    totalRows: previewRows.length,
    emptySkipped: count("empty"),
    ready: count("ready"),
    flagged: count("flagged"),
    held: count("held"),
    notLoaded: count("not-loaded"),
    inserts: count("ready") + count("flagged"),
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };

  return {
    importType: "Historic Load",
    fileName: sheet.fileName,
    missingColumns,
    unexpectedColumns,
    mappings,
    rows: previewRows,
    issues,
    summary,
    // No partial commit: any blocking error (or a template mismatch) stops the whole load.
    canCommit: missingColumns.length === 0 && summary.held === 0 && summary.inserts > 0,
  };
}
