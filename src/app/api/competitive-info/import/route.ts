import { ciRoute, readJson } from "@/server/ci/route";
import { REQUIRES } from "@/server/ci/readiness";
import { ValidationError } from "@/server/ci/errors";
import { commitBulk, commitExcelRows, commitHistoric, previewBulk, previewExcelRows, previewHistoric } from "@/server/ci/services/import";
import type { ImportApiRequest } from "@/types/ci-api";

/**
 * Corporate Marketing Import (BRD §7.5).
 *  - importType "historic" — Historic Load (regional files → new rows)
 *  - importType "bulk"     — Bulk Update (existing rows by Record ID)
 *  - importType "excel"    — Add rows from an Excel file (CI Prototype Import)
 *  - mode "preview" validates and transforms only; "commit" re-validates on
 *    the server and saves only when there are no blocking errors.
 */
export async function POST(request: Request) {
  return ciRoute(request, "POST /api/competitive-info/import", REQUIRES.importRun, async (user) => {
    const body = await readJson<ImportApiRequest>(request);
    if (body.importType === "historic") {
      const result =
        body.mode === "commit"
          ? await commitHistoric(user, body.sheet, body.options)
          : await previewHistoric(user, body.sheet, body.options);
      return Response.json(result);
    }
    if (body.importType === "bulk") {
      const result =
        body.mode === "commit" ? await commitBulk(user, body.sheet, body.changeNote) : await previewBulk(user, body.sheet, body.changeNote);
      return Response.json(result);
    }
    if (body.importType === "excel") {
      const result = body.mode === "commit" ? await commitExcelRows(user, body.sheet) : await previewExcelRows(user, body.sheet);
      return Response.json(result);
    }
    throw new ValidationError(["Unknown import type."]);
  });
}
