# Competitive Intelligence (CI)

A Next.js 16 app for recording competitive market-share data (BRD 1.1 / CI Prototype). It has two roles:
- **Sales:** sees and edits only rows inside their Customer + Segment + Region scope.
- **Corporate Marketing:** sees all data, and manages User Management, Lookups, Sequential Dropdown Lookup, Reference Data, Import and Competitive FF.

**Architecture and data flow:**
- The screen → API → service → repository → Databricks flow, and how to connect the real CI tables, are in **[docs/ci-technical-reference.md](docs/ci-technical-reference.md)**.

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in AUTH_SECRET (see the comments in the file)
npm run dev                  # http://localhost:3000
```

- **Without Microsoft credentials:** set `DEV_MOCK_AUTH=true` (dev only).
- **There is no mock or sample data.** A screen whose CI Databricks table isn't configured yet shows "CI database table configuration is pending: <table names>". User Management reads the shared Databricks user table directly.
- **CI table names and columns** live in one place, `src/server/db/schema.ts`; a table is added there only once its details are confirmed.

## Checks

```bash
npm test          # vitest: CI rules, Import, security/scope tests
npm run lint
npx tsc --noEmit
node scripts/test-warehouse.mjs   # Databricks warehouse connectivity (needs DATABRICKS_* in .env.local)
```

## Deploy

`npm run build`, then `npm start` (`scripts/start-server.mjs`, which listens on `DATABRICKS_APP_PORT` inside a Databricks App).

`app.yaml` and `databricks.yml` still hold placeholder values from a previous app. Replace them with the CI app's values before any CI deployment.
