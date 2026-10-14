# CI technical reference

How data moves through the Competitive Intelligence (CI) app, and exactly where the Databricks connection plugs in.

- CI business rules (fields, scope, edit window, Change Note, Fab Region, Revenue, audit, Import) come from the CI BRD 1.1 and CI Prototype and live only in CI code.
- Reference implementation of the same flow against real Databricks tables: the separate SAMBA project (`latest samba app\samba`). See `src/server/db/delta-store.ts` (`createApplicationRecord`, `updateApplication`, `loadApplicationsPage`) and `src/server/db/mappers.ts`.

---

## 1. The layers

```
CI screen (React, "use client")            src/app/<screen>/page.tsx, src/components/ci/*
  → CI API client (fetch)                  src/lib/ci/api.ts            ciApi.*  → throws ApiError {status, code, details}
  → API route (Next.js route handler)      src/app/api/**/route.ts      ciRoute(request, "...", handler)
      → token forwarding                   src/server/api/with-warehouse-auth.ts, src/server/db/request-auth.ts
      → signed-in CI user                  src/server/ci/current-user.ts   (Auth.js session → User Management record)
      → error → HTTP status                src/server/ci/errors.ts
  → Service (CI business rules)            src/server/ci/services/*.ts
      → shared pure rules                  src/lib/ci/rules.ts, src/lib/ci/field-spec.ts, src/lib/ci/import/*
  → Repository (data access only)          src/server/ci/repository.ts   CiRepository interface
      → pending stub (today)               src/server/ci/repository.ts — refuses per table, never returns data
      → Databricks (TO BUILD)              src/server/ci/databricks/*    (see §6)
          → SQL text                       src/server/db/sql.ts
          → SQL execution                  src/server/db/warehouse.ts
          → row ↔ model mapping            src/server/db/row-values.ts + CI mappers
  → Databricks SQL warehouse → CI tables   (names in src/server/db/schema.ts, still pending)
```

The response travels back the same way:
1. **Repository:** returns CI model objects.
2. **Service:** returns `{ record, notification }`.
3. **Route:** sends the JSON response, using the status code each error type maps to.
4. **`ciApi`:** resolves with that JSON, or throws `ApiError` on failure.
5. **Screen:** shows a banner and reloads.

**Rule:** the browser never talks to Databricks, and no SQL or table name ever appears in a React component.

---

## 2. Add flow (Submit) — as implemented

| Step | File | What happens |
|---|---|---|
| 1. Screen | `src/app/competitive-info/page.tsx` | **Add Row** opens `CompetitiveForm` (mode add) with form options from `GET /api/competitive-info/form-options`. |
| 2. Form checks | `src/components/ci/competitive-form.tsx` | Dropdown options come from `fieldOptions()`, limited to the Sales user's scope and open years. Changing a field clears the fields that depend on it (`applyFieldChange`). **Submit** stays disabled until every required field and the first Change Note are filled. |
| 3. Submit | `competitive-form.tsx` `submit()` | Payload `SaveRecordRequest = { input: formToInput(form), notes }`. Calls `ciApi.createRecord(body)`. |
| 4. API call | `src/lib/ci/api.ts` `request()` | `POST /api/competitive-info` with a JSON body and `cache: "no-store"`. A non-2xx response throws `ApiError(message, status, code, details)`. |
| 5. Route | `src/app/api/competitive-info/route.ts` | `ciRoute()` forwards the Databricks user token, resolves the CI user, reads the JSON (400 if invalid), then calls `createRecordFor(user, body)`. Returns 201. |
| 6. Who is calling | `src/server/ci/current-user.ts` | Email comes from the **verified Auth.js session**, never from the request body. Then `findUserByEmail()` runs; a missing or inactive user gets 403. |
| 7. Service | `src/server/ci/services/competitive-info.ts` `createRecordFor` | Role check → Change Note required (400) → `normalise()` (trim, numbers) → load lookups and reference data → derive **Fab Region** and **Revenue** on the server → **scope check on the submitted values** (403) → Sales only in open years (403) → `validateInput()` (400 with details). |
| 8. Save | repository | `createRecord()` (the repository assigns the Record ID), then `addNotes()`, then `addAudit()` with the field-level `changes` from `diffRecords()`. |
| 9. Notify | `src/server/ci/notifications.ts` | Recipients = active users whose scope covers the row. Log only: delivery is never claimed until an email provider is configured. |
| 10. Response | route → `ciApi` → page | `{ record, notification }` comes back. The page closes the drawer, shows a success banner and reloads the list. On error the form stays open with the user's input and shows the server's message and details. |

## 3. Edit flow — as implemented

1. **Open:** the pencil (shown only when `canEditRecord()` allows) calls `ciApi.getRecord(id)`, which is `GET /api/competitive-info/[id]`. `loadVisibleRecord()` returns **404 for rows outside the user's scope**, so a Record ID typed into the URL reveals nothing.
2. **Edit:** the same form, pre-filled. **Submit** is enabled only when something changed and a new Change Note is entered.
3. **Submit:** `ciApi.updateRecord(id, body)` sends `PUT /api/competitive-info/[id]`, which calls `updateRecordFor()`.
4. **Service:**
   - reload the existing row (404 if out of scope);
   - check the edit window against the **existing** row's year (403);
   - Change Note, `normalise()`, derive Fab Region and Revenue;
   - check scope on the **new** values (no moving a row out of scope, 403);
   - `validateInput()`;
   - build `updated`, then `diffRecords(existing, updated)`; no changes gives a 400.
5. **Save:** `updateRecord(updated)`, then `addNotes()`, then `addAudit({ action: "Edited", changes, note })`.
6. **Response and refresh:** same as Add.

**Audit trail:** the clock icon calls `ciApi.audit(id)`, which is `GET /api/competitive-info/[id]/audit`. The service checks access to the row (404 if out of scope) and returns append-only entries, newest first.

## 4. Data retrieval (list) — as implemented

Each screen loads its data like this:
1. **Screen:** `useCiData(() => ciApi.listRecords())` (`src/hooks/use-ci-data.ts`). It loads once on mount, tracks loading, not-connected and error, and offers `reload()`.
2. **API:** `GET /api/competitive-info` calls `listRecordsFor(user)`.
3. **Service:** calls `repo.listRecords(dataScopeFor(user))`, then filters again by scope as a safety net.
4. **Repository:** must apply the scope **in the SQL WHERE clause**.
5. **Screen:** `DataGrid` filters, sorts and pages in the browser. BRD §9 says data volume is low, and this keeps Export complete.

**If volumes turn out to be large**, switch the list to server-side paging:
- **Endpoint:** `GET ...?limit&offset&<filters>` returning `{ items, total }`. It runs two queries in parallel:
  - `SELECT COUNT(*) … WHERE <scope AND filters>`;
  - `SELECT <columns> … WHERE … ORDER BY … LIMIT/OFFSET`, built with `pageClause()`.
- **Screen:** `usePagedList()` in `src/hooks/use-paged-list.ts`. It ignores stale responses, resets to page 1 on filter changes, and clamps to the last valid page.
- **Search:** `useDebouncedValue()` on the search box.
- **Export:** `fetchAllPages()`.
- **Filter dropdowns:** a small `filter-options` endpoint, because the browser no longer holds every row.

## 5. Authentication and security flow

1. **Sign-in:** Microsoft Entra ID through Auth.js (`src/auth.ts`), using JWT sessions in an HTTP-only cookie. A dev-only login exists only under `npm run dev` with `DEV_MOCK_AUTH=true` (`src/server/dev-auth.ts`).
2. **`src/proxy.ts`, on every request:**
   - no session: redirect to `/login`;
   - a session but no active CI user: redirect to `/access-denied`. If the check itself errors, it fails closed with `?reason=error`;
   - it also copies Databricks Apps' `x-forwarded-access-token` header into the HTTP-only cookie `ci_dbx_user_token`.
3. **Every API call:** `ciRoute()` resolves the CI user from the session, giving role (`Sales` | `CM`) and scope (Customer, Segment and Region, each `"All"` or a list).
4. **Services:**
   - **Role:** `requireRole()`. Corporate Marketing only for User Management, Lookups, Sequential Dropdown Lookup, Reference Data, Import and Competitive FF.
   - **Scope:** `dataScopeFor(user)`. Corporate Marketing gets everything; Sales must match Customer **and** Served Market **and** Fab Region.
   - **Reads:** out of scope gives 404.
   - **Writes:** out-of-scope payloads give 403.
   - **Edit window:** `salesEditWindowOpen()`.
5. **Repository:** receives the scope and filters in SQL.
6. **Screens:** `RoleGuard` hides pages the role can't use. This is convenience only; the server enforces.

## 6. Connecting Databricks — what to build, and where

**Already in place:**

| Piece | File | Notes |
|---|---|---|
| Statement execution | `src/server/db/warehouse.ts` | `executeQuery<T>(sql)` returns objects keyed by column name. `executeStatement(sql)` is for writes. It polls running statements and follows result chunks so large results aren't cut off. `pingWarehouse()`. |
| Token selection | `warehouse.ts`, `request-auth.ts`, `with-warehouse-auth.ts`, `proxy.ts` | Order: **(1)** the user's forwarded Databricks Apps token; on a permission error, retry as the app. **(2)** `DATABRICKS_TOKEN`. **(3)** Service-principal OAuth (`DATABRICKS_CLIENT_ID`/`_SECRET`), token cached. |
| Configuration | `.env.example`, `src/server/config.ts` | `DATABRICKS_HOST` and `DATABRICKS_WAREHOUSE_ID` (or `_HTTP_PATH`) are required. **There are no defaults.** `hasWarehouseBackend()` and `isDatabricksAppRuntime()`. |
| Safe SQL | `src/server/db/sql.ts` | See the table below. |
| Mapping helpers | `src/server/db/row-values.ts` | `str`, `num`, `numOrNull`, `iso`, `isoDate`, `splitList`, `scopeFromText`/`scopeToText`, `isInactiveFlag`, `toJsonColumn`/`fromJsonColumn`. |
| Access cache | `src/server/ttl-cache.ts` | `TtlCache` for the per-request user lookup (a Databricks statement can take about 1 second). |
| Health check | `GET /api/health` | Warehouse reachable? CI tables configured? |
| Smoke test | `node scripts/test-warehouse.mjs` | Runs `SELECT 1` using `.env.local`. |

**What each helper in `src/server/db/sql.ts` does:**

| Helper | Purpose |
|---|---|
| `qCol`, `qTable`, `sqlLiteral`, `sqlIn` | Quote names and values safely. Every value goes through `sqlLiteral`. |
| `whereClause`, `isActiveFilterValue` | Build WHERE clauses; a filter value of "All" is never added. |
| `buildMerge` | Upsert one row by primary key, with insert-only columns. |
| `buildMergeMany` | One MERGE for a whole batch, so it's all or nothing. Use it for Import. |
| `buildInsert` | Append-only rows (audit, notes). |
| `nextSequentialId`, `insertRowIfAbsent`, `insertWithNewId` | Create the next "CI-0042" ID and retry if two saves collide. |
| `withCompensation` | If a later write fails, undo this request's earlier writes. There are no multi-statement transactions. |
| `pageClause` | `LIMIT`/`OFFSET` for paging. |

**To do, once the real catalog, schema, table and column details are provided (nothing below may be guessed):**
1. **`src/server/db/schema.ts`:** replace a pending `null` in `CI_TABLES` with `{ catalog, schema, table }` and add that table's confirmed columns beside it. Each table switches on independently: a screen reports "CI database table configuration is pending: <tables>" (see `REQUIRES` in `src/server/ci/readiness.ts`) until every table it needs is configured.
2. **`src/server/ci/databricks/mappers.ts`:** one pair per table, built with `row-values.ts`. For example `rowToRecord(row) → CompetitiveRecord` and `recordToRow(record) → Record<column, value>`, and likewise for notes, audit (`changes` stored as JSON through `toJsonColumn`/`fromJsonColumn`), lookups, reference data and users (scope columns through `scopeFromText`/`scopeToText`).
3. **`src/server/ci/databricks/repository.ts`:** implement `CiRepository` with `executeQuery`/`executeStatement` and `sql.ts`:
   - **`listRecords(scope)`:** WHERE clause from the scope (Customer IN …, Served Market IN …, Fab Region IN …; "All" adds nothing; an empty list matches nothing).
   - **`createRecord`:** `insertWithNewId(table, "<record id column>", "CI", id => recordToRow({...record, recordId: id}))`.
   - **`updateRecord`:** `buildMerge(table, "<record id column>", recordToRow(record), /* insert-only */ {created columns})`.
   - **`createRecords`/`updateRecords`:** one `buildMergeMany` (or a staging table, then a single MERGE), so Import is never half-saved.
   - **`addNotes`/`addAudit`:** `buildInsert` (append-only).
   - **Owned-row and lookup-usage counts:** add COUNT/GROUP BY repository methods instead of loading every row (see §7).
4. **`src/server/ci/repository.ts`, `getCiRepository()`:** return the Databricks-backed methods table by table (`REPOSITORY_METHOD_TABLES` lists the tables each method uses). There is no mock fallback; test fixtures live in `src/server/ci/testing/` and are importable only by tests.
5. **Services:** usually nothing changes; that's the point of the repository layer. If a create writes several statements, wrap the later ones in `withCompensation()`.
6. **`src/server/ci/access.ts` and `current-user.ts`:** cache the user lookup with `TtlCache` (about 30 seconds), and clear an email's entry on every User Management write.
7. **Deployment (`app.yaml`, `databricks.yml`):** still hold placeholder values from a previous app; replace them with the CI app name, URL and warehouse once known.
8. **Permissions:** the app's service principal needs `USE CATALOG`/`USE SCHEMA`/`SELECT`/`MODIFY` on the CI tables and `CAN USE` on the warehouse. Grant these to the app's service principal; never reuse grant scripts written for another app's tables.

## 7. Known performance items for the Databricks phase

- **Two user lookups per API call:** one in `proxy.ts` and one in `ciRoute`. Cache them (see §6, step 6).
- **User Management "Rows owned", off-boarding, and lookup "in use":** once the CI tables are connected these would load every row, which is fine at low volume. Replace with COUNT queries if the data grows.
- **All Competitive Info:** loads every in-scope row. Switch to server paging (§4) only if volumes need it.
- **Form options (lookups + reference data):** read on every save and every visit to All View. Consider a short server-side cache.

## 8. Patterns CI deliberately avoids

- **Trusting a user ID sent by the browser** (`actingUserId`/`requesterId` in the body). CI uses only the session.
- **Returning raw error text** (it may contain SQL) to the browser. CI logs it and returns a generic 500.
- **Row-by-row import writes.** CI Import must be all or nothing.
- **"Previous value" shadow columns on the main table.** CI keeps history in the append-only audit trail.
- **Default workspace, warehouse, catalog or schema values in code.** Everything comes from the environment and `server/db/schema.ts`.

## 9. User Access (SAMBA's sign-in allowlist, `corp_marketing_dev.samba.samba_user`)

> **The User Access screen has been removed** (it is not in the current CI prototype): its page and sidebar entry are gone. The server code, the `/api/user-access` routes and `USER_ACCESS` in `schema.ts` are still in place (the authorization function in `access.ts` is shared by Login History and the Competitive Info gallery) and can be deleted separately.

The same screen and add-user workflow as SAMBA's Admin → User Access, on the same table. Add-only: a row means "may sign in"; there is no edit or remove, as in SAMBA.

```
src/app/user-access/page.tsx                  screen (gallery + Add User form + Entra picker)
  → src/lib/ci/api.ts                         ciApi.userAccess / userAccessDirectory / addUserAccess
  → src/app/api/user-access/route.ts          GET list (read-only), POST add (WRITES one row)
  → src/app/api/user-access/directory/route.ts  GET Entra directory (read-only, no Databricks)
  → src/server/ci/user-access/service.ts      listUserAccess / listDirectory / addUserAccess (injectable deps)
      access.ts      who may use it            data.ts       SQL builders + row mapper
      directory.ts   Microsoft Graph (server)  validation.ts request checks
  → src/server/db/schema.ts                   USER_ACCESS: table + column names (the only place)
```

- **Only `POST /api/user-access` writes**: one MERGE insert into `samba_user`. It also lets that person pass SAMBA's access gate. Duplicate emails (case-insensitive) are refused with SAMBA's message. "Modified By" is the signed-in person, never a client-sent name.
- **Authorization (`access.ts`):** local development with the existing dev login (`NODE_ENV=development` and `DEV_MOCK_AUTH=true`) is allowed; this can never be on in a production build. Everywhere else the verified session email must hold an active "Corporate Marketing" row in the shared user table, checked on every API call. Replace that one function when CI's own authentication and roles exist.
- **Directory search** needs `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` on the server and Microsoft Graph `User.Read.All` (application, admin-consented). Without them the picker says it isn't configured; in local development only it offers manual name + email entry.

## 10. Login History (who signed in, and when)

The CI prototype's Login History screen, on CI's own table. **The CI table is not configured yet**, so the screen shows "CI database table configuration is pending: Login History" and records nothing.

```
src/app/login-history/page.tsx            screen: 3 tiles, search, Event / User filters, Export to Excel, table
  → src/lib/ci/api.ts                      ciApi.loginHistory
  → src/app/api/login-history/route.ts     GET (read-only)
  → src/server/ci/login-history/service.ts table configured? → connected? → scope (all / own) → read
      repository.ts   list() / record()     data.ts   SQL builders + row mapper (names come from the schema)
      capture.ts      recordLoginEvent()    called from the sign-in / sign-out events in src/auth.ts
  → src/server/db/schema.ts                 CI_TABLES.loginHistory + LOGIN_HISTORY_COLUMNS  (both pending, null)
```

- **Who sees what:** Corporate Marketing (the shared authorization function) sees every user's sign-ins; everyone else sees only their own ("My Login History"). The person is the verified session email; the browser sends nothing that widens it.
- **Columns:** `id`, `email`, `name`, `loginTime` are required. Role, Event, Result, Device, IP address and Note (the prototype's other columns) are **optional**: a column is read, shown and written only if it is named in `LOGIN_HISTORY_COLUMNS`. Sign-in and sign-out set Event and Result when those columns exist; Role, Device, IP and Note are not known at that moment and are left blank. Failed sign-ins cannot be captured through the sign-in event, so the "Failed attempts" tile shows "not recorded" unless a Result column exists and something writes failures.
- **Recording** is best-effort: it never throws and never blocks a sign-in; the local development login is never recorded.
- **To finish the integration**, fill in `CI_TABLES.loginHistory` and `LOGIN_HISTORY_COLUMNS` in `src/server/db/schema.ts`, after checking that a row needs no other column.

## 11. Alignment with the current CI prototype (October 2026)

- **Data model:** 24 grid fields. "Competitor Product" and the separate "Product Name" list became **one Product Name field that cascades from Top Competitor** (this also matches the real `ci_main` table, which has a single `product_name`). The "Product Name" lookup category was removed; Top Competitor, Process Location and Fab Region are lookup categories, all listed under Lookups → Dropdown lists (Fab Region is stored as a list but the form still derives a row's region from its fab). Historic load validates the file's Product Name against the competitor's product list.
- **Navigation:** Home, All Competitive Info View, Competitive FF, Import, User Management, Lookups, Sequential Dropdown, Login History ("My Login History" for Sales). `/` is the Home screen: greeting, six most recently updated rows (opens the audit trail), quick actions, and Rows / Customers / Competitors tiles, all from `GET /api/competitive-info` (pending until that table is configured).
- **Excel:** every export is an .xlsx workbook (`src/lib/xlsx.ts`, JSZip): All Competitive Info (shown columns only), Competitive FF, Lookups (one sheet per list), Sequential Dropdown, Login History. The Import template is the 20 user-entered column headings, no sample rows.
- **Import:** a new first tab, **Add rows (Excel)**: validate every row with the manual-entry rules, list rows with problems, import the valid ones (`lib/ci/import/add-rows.ts`, `POST /api/competitive-info/import` with `importType: "excel"`). Historic load and Bulk update are unchanged.
- **Lookups:** one grouped list ("Dropdown lists", "Dependent lists"), delete confirmation, Excel import of new dropdown values. Rename, every dependent-list edit and the "Modified by / on" stamp need CI tables that do not exist yet and are shown disabled.
- **Sequential Dropdown:** Customer, Served Market, Top Competitor, Product Name, Process Location, Technology Node; Excel download / import; the order is saved for Served Market and Top Competitor, the rest wait for Reference Data to hold an order.

## 12. Lookups on `ci_lookup`

- Table `corp_marketing_dev.ci.ci_lookup`; columns in `LOOKUP_COLUMNS` (`server/db/schema.ts`). One row per list value: `lookup_type` is the list name as the Lookups screen shows it, `display_order` is the Sequential Dropdown position, `is_active` hides a removed value.
- Code: `server/ci/databricks/lookups.ts` (only reader/writer of the table), `server/ci/lookups/service.ts`, routes `/api/lookups`, `/api/lookups/[id]`, `/api/lookups/order`.
- Writes: add = one MERGE, remove = UPDATE `is_active = FALSE` (never DELETE), reorder = one UPDATE per list. All pass `assertLookupWriteStatement` (single MERGE/UPDATE of `ci_lookup` only).
- Authorization: Corporate Marketing (or the dev login), via `authorizeUserAccessManager`; independent of the CI users table.
- "Used by N rows" counts come from `ci_main` via `LOOKUP_USAGE_COLUMNS`. Wafer Size has no count until the stored-type decision is made.
- Open: whether `lookup_type` strings stay as display names; `is_active` NULL is treated as inactive; the lookup id is a UUID.

## 13. Read-only paths: ci_lookup_dependent, ci_user_management, form options

- `CI_TABLES.dependentLookups` = `ci_lookup_dependent`, `CI_TABLES.userManagement` = `ci_user_management`. Both have raw, read-only stores (`server/ci/databricks/dependent-lookups.ts`, `user-records.ts`); neither has a write path.
- `CI_TABLES.users` (which drives CI sign-in authorization) is deliberately still pending. Nothing authorizes from `ci_user_management` yet.
- Dependent lookup rows are not interpreted: the `parent_type_*` / `child_type` strings are pending approval.
- `GET /api/user-management/ci-users` returns rows as stored (status, is_active, scope text untouched). `GET /api/competitive-info/form-options` returns the `ci_lookup` lists, without Wafer Size, plus `pendingSources` naming what is not yet available.

## 14. Wafer Size mapping and interim lookup rules

- Approved mapping (`lib/ci/wafer-size.ts`): `300mm (12")` ↔ 300, `200mm (8")` ↔ 200, `150mm (6")` ↔ 150. `ci_main.wafer_size_mm` is DOUBLE; the live data holds only 150.0 / 200.0 / 300.0 (52 / 43 / 405 rows). The mapping is for display, form selection and the Lookups usage count; stored data and the schema are untouched. A value outside the mapping is shown as stored and reported on the Competitive Info page, never converted.
- "Used by N rows" counts every `ci_main` row (inactive included). It is a separate query from `ci_lookup.is_active`, which only decides whether a value is offered; NULL `is_active` = not offered.
- Dependent-lookup type strings, Fab Region format, master sources and the CI authorization source remain pending approval.

## 15. Fail-closed CI authorization and SAMBA write block

- `server/ci/authorization/ci-access.ts` is the only authorizer for the non-login screens (Lookups, gallery, form options, User Management, User Access). It reads `ci_user_management` only, has no development bypass and never consults SAMBA. `CI_TABLE_AUTHORIZATION_APPROVED` is `false` until the approach is approved, so every call is refused before any database is contacted. When enabled, `decideCiAccess` requires exactly one active record, a clear `is_active`, a blank or "Active" status, and a role of exactly `Account Team` or `Corporate Marketing`. `All` in a scope column grants nothing by itself.
- `server/db/write-guard.ts` runs inside `executeStatement`: writes are limited to tables in `corp_marketing_dev.ci`; any SAMBA reference, other schema, DDL or maintenance command is refused. SAMBA shared-table writes (`sharedTableWritesEnabled`) are always off; the legacy SAMBA User Management view/manage checks fail closed.
- Login History still uses its own earlier check (`user-access/access.ts`), untouched because it is out of scope.
- User Management (`/user-management`) reads `GET /api/user-management/ci-users`. Under `next dev` a button shows browser-only MOCK users (`lib/ci/dev-mock-users.ts`); they are never sent to, or read from, the server.

## 16. Authorization approved; page gate fail-closed

- `CI_TABLE_AUTHORIZATION_APPROVED = true`. With `ci_user_management` empty, nobody is authorized, so every protected route and page is denied. Rule: exactly one record for the email with `is_active = TRUE` and `status = "Active"` (CI's existing vocabulary is Active / Off-boarded), role exactly `Account Team` or `Corporate Marketing`; NULL, duplicates or anything else = denied.
- `src/proxy.ts` now denies a signed-in person without a valid record (redirect to `/access-denied`), including when the table is empty or unconfigured. Account Team can open Home and All Competitive Info View only (`roleMayOpenPage`); the other pages redirect with `?reason=role`. The local development login is exempt from the page gate only (it holds no CI role; every API still refuses it).
- Account Team data access stays denied: scope storage is not approved, so no scope is applied yet.

## 17. Account Team scope, dev-login exemption removed

- Scope storage: `ci_user_management.customer / segment / region` (STRING) hold a JSON array of text for Account Team, for example `["TSMC","UMC"]`; `authorization/scope.ts` parses strictly (no blank, All, duplicates, non-text, empty list, over 200 values) and any invalid dimension denies the person. Serialization (`serializeScope`) trims, de-duplicates and refuses anything the reader would refuse. No schema change; no write path exists yet. One active row per email is enforced by the authorizer (several active rows = denied). `ci_user_id` as a UUID fits the STRING column.
- Enforcement: the gallery (`ci_main`) applies Customer AND Segment (served_market) AND Region (fab_region) in the SQL WHERE clause and again on every returned row, and refuses if those columns are not in the table. Corporate Marketing is unscoped.
- `proxy.ts` has no exemption for the dev login: in development the SAME rule runs over MOCK records (`lib/ci/dev-mock-users.ts`) for page shells and the session only; every API reads the real table and refuses the dev login real data. Try the Account Team view with DEV_MOCK_AUTH_EMAIL=mock.at1@mock.invalid.
- Master-list templates for approval: `docs/master-templates/`. Change Notes / Audit design: `docs/ci-change-notes-audit-design.md`.

## 18. Add User form, Fab Location mapping

- **Add User** (`components/ci/add-user-dialog.tsx`, rules in `lib/ci/user-form.ts`): three separate levels. (1) Open and validate: always available, nothing sent. (2) Save a local test entry: development builds only, kept in the browser tab, labelled MOCK, never sent. (3) Save to Databricks: disabled; the dialog shows the exact row such a save would insert into `corp_marketing_dev.ci.ci_user_management` for approval. Roles: Account Team / Corporate Marketing only. One record per email. Account Team scope: JSON-array text, no All.
- **Mount:** no such feature exists in the CI code, build output or the SAMBA source (every "mount" is a React lifecycle comment or the word "amount"); nothing was removed.
- **Fab Location / Fab Region:** `dependent-lookups.ts` `fabMappingsFrom` builds the list from active `ci_lookup_dependent` rows with exactly Customer / Fab Location / Fab Region. Rows without a region are left out and reported (no placeholder); two active rows for one Customer + Fab Location are both left out and reported. A customer with no mapping gets an empty Fab Location list and "No Fab Locations available for this customer."
- Retired from the client: the SAMBA shared-user API calls (their server routes still exist but fail closed).

## 19. User Management writes (Add / Edit / Deactivate / Reactivate)

- Routes: `POST /api/user-management/ci-users`, `PUT` and `DELETE /api/user-management/ci-users/[id]`, `POST .../[id]/reactivate`. Service: `server/ci/user-management/ci-users-write.ts`; table access: `server/ci/databricks/user-records.ts` (the only reader/writer of `ci_user_management`).
- Every call: table configured -> connected -> Corporate Marketing (verified session + `ci_user_management`, no dev bypass) -> server-side validation (`lib/ci/user-form.ts`, the same rules as the form) -> one guarded write (single MERGE/UPDATE of this table, plus the global `ci`-schema write guard).
- Insert is a MERGE that inserts only if no record has the email (case-insensitive), then re-reads to confirm the row landed, so one record per email holds even under a race. "Delete" = deactivate (`is_active = false`, `status = Off-boarded`); no row is ever removed; deactivated users are reactivated, not re-added. Nobody can deactivate themselves or change their own role, and one active Corporate Marketing user always remains (`lib/ci/user-rules.ts`).
- Timestamps are written with an explicit `CAST('...' AS TIMESTAMP)` (`tsLiteral`, also used by the Lookups writes). The pieces of these statements were evaluated read-only against the live tables; no write has been executed against Databricks.
- Add/Edit Competitive Info: Submit is disabled with the reason (no Change Note / Audit tables approved), not left looking functional.

## 20. Scope with All, Add User form, Lookups per prototype (3)

- **Scope storage** (existing `ci_user_management.customer / segment / region` STRING columns, no schema change): each dimension is exactly the text `All` or a JSON array of text (`["TSMC","UMC"]`). `All` is a defined scope, never a value in a list; `["All","X"]`, `[]`, blanks, repeats, wrong casing (`all`) and plain text are INVALID, and a person with any invalid dimension is denied. Rule and parser: `server/ci/authorization/scope.ts`; form rules: `lib/ci/user-form.ts` (the server runs the same function before the insert).
- **Enforcement:** the gallery adds `column IN (...)` only for dimensions set to specific values (All adds nothing; All / All / All has no WHERE) and re-checks every returned row. Corporate Marketing is unscoped.
- **Validation against lists:** Served Market and Region values must be in the active `ci_lookup` lists "Served Market" / "Fab Region" when those lists have values; Customer has no approved master, so it is checked for shape only.
- **Add User form:** Customer, Served Market and Region are always shown; Corporate Marketing = read-only All; Account Team = "All" or specific values per field. Buttons: Cancel and Save only. The local-mock-users toggle was removed from User Management (the dev page-gate records in `lib/ci/dev-mock-users.ts` remain for the dev login only).
- **Edit / Deactivate / Reactivate:** built and tested but OFF (`USER_EDIT_DELETE_ENABLED = false`); the page shows no row actions and the routes refuse after authorization.
- **Lookups** now follows CI Prototype (3).html: tabs Dropdown Lists / Cascading Lists, Import all / Export all, per-list Import / Export, value rows with "used by N rows". Differences: Excel files instead of pasted CSV, Remove asks for confirmation, Rename and every cascading-list edit are disabled with a reason. Only Customer -> Fab Location (+ Fab Region) reads data; the other three cascades are "not connected".

## 21. User Management: Add User saves directly; development-only access

- There is no first-user setup flow, setup key, setup notice or special first-user logic. Add User is one ordinary form (fields, validation and design unchanged); Save sends the user to `POST /api/user-management/ci-users`, which validates on the server and inserts one row into `corp_marketing_dev.ci.ci_user_management`.
- Authorization (`server/ci/authorization/dev-access.ts`): the normal Corporate Marketing check (`authorizeCorporateMarketing`) is used first. The ONLY exception is the local development login: when `NODE_ENV === "development"` AND `DEV_MOCK_AUTH === "true"` (`isDevMockAuthEnabled()`) a caller the normal check refuses may list users and Add User. A production build always runs as `production`, so the rule can never apply there. It covers User Management only; Lookups, the gallery and every other screen keep the normal check, and Edit / Deactivate stay off for everyone.
- Success is reported only after the database confirms it: the insert is a MERGE that adds the row only if no record has the email (case-insensitive), then the table is re-read; if the row is not there the request fails with a conflict, and a database error is returned as an error, never as success.
- `name@localhost` (the development login's address) is accepted as an email in development builds only.
- Once a Corporate Marketing record exists for the developer's email, the normal check passes by itself and the development rule is never reached.
- Production still needs: a verified sign-in (Microsoft Entra), a per-environment catalog setting (the dev catalog is hard-coded today) and a CI-specific app.yaml.

## 22. Lookups, Sequential Dropdown and dependent lists (Draft_Version1)

- Screens follow `Draft_Version1`: Lookups (one list with "Dropdown lists" and "Dependent lists", Import from Excel / Export to Excel), Sequential Dropdown (tabs, search, drag or typed order, pager), Import (one Excel card; Historic load and Bulk update panels are kept in code but not shown).
- `ci_lookup` (independent values): `lookup_type` = list, `lookup_value`, `display_order`, `is_active`, audit columns. Add = MERGE insert, rename = UPDATE `lookup_value`, remove = UPDATE `is_active = FALSE`, reorder = one UPDATE of `display_order`. Never a DELETE from the app.
- `ci_lookup_dependent` (cascades): `parent_type_1/value_1`, `parent_type_2/value_2`, `child_type/value`, `display_order`, `is_active`, audit columns. Type strings (`DEPENDENT_MAPPINGS` in `server/ci/databricks/dependent-lookups.ts`; Fab approved, the rest PROPOSED): Product Name = Top Competitor -> Product Name; Process Location = Served Market -> Process Location; Fab = Customer + Fab Location -> Fab Region (Fab Location in `parent_value_2`, region in `child_value`); Technology Node = Customer + Served Market -> Technology Node. Order is kept per parent group.
- API: `GET/POST /api/dependent-lists`, `PATCH/DELETE /api/dependent-lists/[id]`, `PUT /api/dependent-lists/order`, `PATCH /api/lookups/[id]` (rename). Corporate Marketing only; parents must be values of their dropdown list (Top Competitor, Served Market); a Fab Region must already be in use or in the Fab Region list; duplicates are refused case-insensitively.
- The Add/Edit form options (`/api/competitive-info/form-options`) now read all four cascades from the same table. Customer has no approved master, so it offers the customers that have a Fab Location or Technology Node mapping (interim rule).
- Live-tested in the CI schema only (add, rename, reorder, remove, Excel import, cleanup); all test rows were deleted afterwards. SAMBA was never touched.

## 23. Performance

- Every Databricks statement costs about 0.8-1.7 s (warehouse round trip), so speed comes from sending fewer statements one after another, not from faster statements.
- `server/ci/authorized-reads.ts` runs the authorization check and the reads of a request at the same time. Authorization is still decisive (a refusal is thrown first and the reads are discarded; nothing is written before it passes).
- Lookups and dependent-list writes no longer reload the screen: once the server confirms, the list is updated in place and fresh data is fetched quietly in the background (`useCiData` has `mutate` and `refresh`; `reload` still shows "Loading…").
- Excel import is two calls (`POST /api/lookups/bulk`, `POST /api/dependent-lists/bulk`): one authorization, one read and ONE write statement for all valid rows; each row is validated like a single add and refused rows are reported.
- Measured on the dev server (before -> after): add ~8 s -> ~4 s, import of 10 values ~60 s -> ~7 s. `next dev` compiles on first use and is slower than a production build.

## 24. Customer and Top Competitor are independent lists

- `Customer` is now a normal independent list in `ci_lookup` (`lookup_type` = "Customer"; no schema change). It is in `LOOKUP_CATEGORIES`, shown under Lookups > Dropdown lists, ordered in Sequential Dropdown, and counted for "used by N rows" from `ci_main.customer`.
- The Customer dropdown of the Add/Edit form is this list. The parents of Customer -> Fab Location and of Customer + Served Market -> Technology Node come from it, and the server refuses a fab or node whose customer is not in the list. "New Customer" under Customer -> Fab Location adds the customer to the Customer list.
- `Top Competitor` is back in the Dropdown lists (it was hidden to match the prototype), so a competitor can be renamed or removed; "New Top Competitor" under Product Name still adds to the same list. `Process Location` stays out of the Dropdown lists (it is only a child of Served Market).
- Excel import: a new customer, competitor or market can be added on the "Dropdown Lists" sheet and used as a parent on the dependent sheets in the same file (dropdown values are saved first).
- No data migration was needed: the existing dependent rows were all inactive.

## 25. Competitive FF reads ci_main

- `GET /api/competitive-ff` -> `server/ci/competitive-ff/service.ts` reads `corp_marketing_dev.ci.ci_main` (read-only): the live rows (`is_active = TRUE`), newest `created_date` first, at most 5,000 (a notice is shown if the table holds more). Corporate Marketing only (`authorizeCorporateMarketing`, checked at the same time as the read; a refusal discards the rows). Account Team is refused.
- Column map `server/db/main-columns.ts` (verified with DESCRIBE TABLE): ci_id, quarter, year, customer, fab_location, fab_region, served_market, technology_node, wafer_size_mm (shown with its approved label), process_application, process_type, process_location, films, product_line, top_competitor, product_name, process_modules, order_type, actual_order, asp_million, currency, revenue_sales_currency, tool_type, created_by, created_date, modified_by, modified_date, is_active.
- The screen (tiles, filters, bar chart, Export to Excel) is unchanged; its numbers are computed from the rows returned. Export carries Record ID plus all 24 fields.
- Dev note: after adding a new export to an existing module (for example in `server/db/schema.ts`), the running `next dev` can keep serving the old module until it is restarted; the column map therefore lives in its own new file.

## 26. Home reads ci_main

- `GET /api/home` -> `server/ci/home/service.ts` (read-only): live rows (`is_active = TRUE`) of `corp_marketing_dev.ci.ci_main` in the signed-in person's view. Two small queries run together after authorization: counts (rows, distinct customers, distinct top competitors) and the 6 most recently created-or-modified rows (`COALESCE(modified_date, created_date)`, newest first).
- Corporate Marketing sees every live row. Account Team sees only rows inside their scope: the same `IN (...)` predicates as the gallery (`scopePredicates`, shared) in both queries, and the listed rows are checked against the scope again. Anyone without CI access is refused.
- The screen layout is unchanged. "Emails received" (no in-app mailbox) and "N open for you to edit" (editing is not enabled yet) are not shown.


## 27. Sign-in: Microsoft login page (as in SAMBA)

- CI keeps a branded `/login` page with "Sign in with Microsoft", the same design as SAMBA: Auth.js (next-auth v5) with the Microsoft Entra ID provider (`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`), a JWT session in an encrypted HTTP-only cookie, `src/proxy.ts` as the page gate and `/access-denied` for refusals. An attempt to replace it with Databricks-Apps-only identity was reverted at the owner's request.
- Differences from SAMBA, all deliberate: the access gate is the CI User Management record (`ci_user_management`, fail closed, role + scope) instead of `samba_user`; a local-development login (`DEV_MOCK_AUTH`, `next dev` only) exists so screens can be built without Microsoft; sign-in events are recorded by `server/ci/login-history` once the CI login-history table is configured (not yet).
- Lookups, Sequential Dropdown, Import, Competitive FF and Home do not depend on the sign-in code and are unaffected by it.

## 28. SAMBA code removed; Microsoft directory picker; one identity email

- **SAMBA independence (Step 2).** No CI code reads or writes a SAMBA table. The old shared-table User Management service, the `samba_user` User Access path and their constants and routes were removed. `requireConnected` now lives in `server/ci/connection.ts` and the API route wrapper is `ciApiRoute` in `server/ci/api-route.ts`. The write guard still refuses any SAMBA statement. The read guard is unchanged (a separate, unapproved step).
- **Add User picks from the Microsoft directory.** The dialog (`components/ci/directory-user-picker.tsx`) searches `/api/user-access/directory`. On Save the server (`server/ci/user-access/resolve.ts`) checks the email against the directory again and stores the directory's own email and display name, never the browser's. If the directory cannot be read, production refuses with the reason; only the local development login may type a name and email by hand.
- **One identity email for sign-in and directory** (`lib/ci/identity-email.ts`): sign-in uses the ID token `email` claim, else `preferred_username` (UPN); the directory uses `mail`, else `userPrincipalName`. A person already saved under their other address blocks a duplicate record.
- **Created By / Modified By** always come from the authorized server session record (`authorizeCorporateMarketing`), never from the request.
- **Microsoft requirements.** The directory search is app-only (client credentials), so it needs the Microsoft Graph **Application** permission `User.Read.All` with admin consent. A Delegated `User.Read.All` does not help. The running server caches the Graph token (about an hour) and the directory list (5 minutes), so restart it after consent is granted. Redirect URIs: `http://localhost:3000/api/auth/callback/microsoft-entra-id` and the deployed app's `/api/auth/callback/microsoft-entra-id`.
- **Not enabled:** Login History recording (`Signed in` insert, `Signed out` handler) and the email-filtered access query.
- **Directory picker switch (currently ON).** `MICROSOFT_DIRECTORY_PICKER_ENABLED` in `lib/ci/directory-picker.ts` is `true`: Add User picks the person from the Microsoft directory and the server re-checks the email against it. Set it to `false` to go back to typed names and emails with no directory lookup. Edit, deactivate (the trash icon) and reactivate on User Management are on (`USER_EDIT_DELETE_ENABLED`).

## 29. Change notes and audit history (existing tables, no new columns)

- **Tables.** Change notes: `corp_marketing_dev.ci.ci_change_note` (`change_note_id`, `ci_id`, `action_taken_by`, `action_timestamp`, `additional_notes` + the created/modified columns and `is_active`). Audit history: `corp_marketing_dev.audit.ci_audit_history` (`audit_id`, `entity_name`, `record_id`, `action_taken`, `field_name`, `old_value`, `new_value`, `comments`, `action_by`, `action_timestamp` + the created/modified columns). Column maps: `CHANGE_NOTE_COLUMNS` and `AUDIT_HISTORY_COLUMNS` in `server/db/schema.ts`. Stores: `server/ci/databricks/{change-notes,audit-history,records}.ts`.
- **Write guard.** It still allows only `corp_marketing_dev.ci.*`, plus exactly one table outside it: `corp_marketing_dev.audit.ci_audit_history`, and only with INSERT (append-only). Every other audit table, such as `ci_login_history`, stays refused.
- **Audit shape.** One row per changed field, grouped back into one entry when read. `field_name` is the field label; a missing value is NULL; `comments` carries the Change Note text. `action_by` stores `Name <email>` (the table has no email column) and is split back into a name and an email when read. Entities: `Competitive Info`, `User`, `Lookup`, `Dependent Lookup`.
- **Order of writes.** Add / Edit of a competitive row: row, then Change Note, then audit entry; if the note or audit cannot be written the row is undone (a new row is set inactive, an edited row gets its old values back) and the person is told nothing was saved. Users: the audit entry is written first; if it fails nothing is saved. Lookups and dependent lookups: change, then audit entry; if the audit fails the person is told the change was saved but its audit entry was not.
- **Competitive rows (`ci_main`).** New rows get a UUID Record ID (the existing ids are UUIDs), `is_active = TRUE` and the UTC day as the DATE `created_date`; `modified_date` is a TIMESTAMP set on edit. Wafer Size is stored through the approved label mapping and refused if it is not one of 300 / 200 / 150. Only the user-entered fields are read from a request; a client-sent createdBy / modifiedBy is ignored.
- **Who.** The signed-in user comes from `ci_user_management` (strict, fail closed, no development bypass) and the name recorded is the verified Microsoft display name.
- **Not covered yet.** Import commit (batch create / update / reassign) still refuses, and so does its audit.

## 30. Login History (corp_marketing_dev.audit.ci_login_history)

- **What is recorded.** One row per completed, SUCCESSFUL Microsoft sign-in, written from the Auth.js `events.signIn` hook in `src/auth.ts` (the same hook SAMBA uses), never awaited and never able to block a sign-in. Sign-outs, failed sign-ins and access-denied events are not recorded, and the local development login is not recorded.
- **Where each column comes from.** `login_id` a new UUID; `login_timestamp` and `created_on` the server clock at sign-in (UTC, explicit TIMESTAMP cast); `user_email` and `user_name` the verified Microsoft identity from the sign-in event (name falls back to the email); `role_name` the person's CI role from `ci_user_management` when they have a valid active record, otherwise NULL; `event_type` is always `Signed in` and `result` always `Success`; `device_info`, `ip_address` and `note` are left NULL (the sign-in event carries none of them).
- **Screen.** `/api/login-history` reads the table newest first. Corporate Marketing sees every sign-in; anyone else sees only their own, matched on the verified session email.
- **Write guard.** INSERT only on this table (no update, delete or merge), like the audit history. Column map: `LOGIN_HISTORY_COLUMNS` in `server/db/schema.ts`.
- **Not done.** `ci_user_management.last_sign_in` is not updated on sign-in.

## 31. All Competitive Info View: row actions

- Every row has an **Actions** column at the end (as in SAMBA) with two icons. The **pencil** opens the Edit form: the row and its Change Notes are read fresh from `GET /api/competitive-info/[id]`, Save needs a new Change Note and goes to `PUT /api/competitive-info/[id]` (row, note and audit entry, with the undo-on-failure rule in section 29). The **history icon** opens the row's Audit Trail drawer from `GET /api/competitive-info/[id]/audit` (who, when, old and new value per field, and the Change Note).
- The server decides who may edit or see each row (role, Customer / Served Market / Region scope, the Sales edit window); the icons are only shown, never trusted. The browser finds the Record ID and the drawer title values by the names in `lib/ci/main-columns.ts` (kept equal to `server/db/main-columns.ts` by a test).

## 32. User Access screen and the two-step sign-in gate

- **Screen** (`/user-access`, Corporate Marketing only, left menu above Login History), modelled on SAMBA's Admin > User Access and separate from User Management. An add-only list: **Add User** opens a card with a **Username** dropdown (search by name or email over the Microsoft directory) and a read-only **User Email**; the table shows User Name, User Email, Modified By, Modified On, newest first, 100 per page. No edit or delete. A person already in the table is refused with "For the selected values, the user is already included in the Table."
- **Table:** `corp_marketing_dev.ci.ci_user_access` (`ci_user_access_id, user_name, user_email, created_by, created_on, modified_by, modified_on, is_active`). Code: `server/ci/databricks/user-access.ts` (one guarded insert-when-absent MERGE keyed on the lower-cased email), `server/ci/user-access/entries.ts` (service), `/api/user-access` (GET list, POST add).
- **Audit:** every add writes an `audit.ci_audit_history` entry first (entity "User Access", User Name and User Email); if that fails nothing is saved. Created By / Modified By is the verified signed-in user, never browser input.
- **Sign-in gate (both required):** (1) an active `ci_user_access` row, and (2) a valid active `ci_user_management` record. **Corporate Marketing is exempt from step 1** (as SAMBA exempts Admin) so someone can always open the screen to add the first people; Account Team users with no row are denied. Checked on every request (`access.ts` for pages, `authorization/ci-access.ts` for APIs); a failed lookup denies. The local development login skips step 1.

## 33. Deploying to Databricks Apps (checklist)

Nothing has been deployed. `app.yaml` and `databricks.yml` carry the same runtime config (kept equal by hand).

- **Build/start:** Databricks installs dependencies and runs `npm run build`; the app starts with `node scripts/start-server.mjs` (`next start` on `DATABRICKS_APP_PORT`).
- **Env actually read by the code:** `DATABRICKS_HOST`, `DATABRICKS_WAREHOUSE_HTTP_PATH`, `AUTH_URL`, `AUTH_SECRET`, `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`. The platform injects `DATABRICKS_CLIENT_ID/SECRET` (the app's service principal) and the port. No token is set. `SAMBA_DATA_MODE`, `CI_SCHEMA` and `DATABRICKS_CATALOG` were not read by any code and were removed.
- **App resources to create:** the SQL warehouse (CAN USE, in `databricks.yml`) and four secrets named `azure_tenant_id`, `azure_client_id`, `azure_client_secret`, `auth_secret` (scope/keys are yours to choose).
- **Microsoft Entra app registration:** add the redirect URI `<AUTH_URL>/api/auth/callback/microsoft-entra-id` (Web platform); keep the Graph Application permission `User.Read.All` (admin consent) for the directory picker. `AUTH_URL` must be updated to the new app's real address after the first deploy.
- **Unity Catalog grants for the app's service principal:** USE CATALOG on `corp_marketing_dev`; USE SCHEMA + SELECT + MODIFY on `corp_marketing_dev.ci` (all CI tables); USE SCHEMA on `corp_marketing_dev.audit` with SELECT and INSERT only on `ci_audit_history` and `ci_login_history`. The code's write guard enforces the same limits.
- **Before first use:** `ci_user_management` needs at least one active Corporate Marketing record (bootstrap), because Corporate Marketing is the only role that can open User Access / User Management. Account Team users also need a `ci_user_access` row.
- **Never set** `DEV_MOCK_AUTH` in the deployed app.
