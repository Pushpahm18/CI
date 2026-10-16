import { ciApiRoute } from "@/server/ci/api-route";
import { loadFfAnalysis, parseAnalysisQuery } from "@/server/ci/competitive-ff/analysis";

/** Competitive FF Analysis: totals, groups and periods calculated in Databricks over every row matching the filters. Corporate Marketing only. Read-only. */
export async function GET(request: Request) {
  return ciApiRoute(request, "GET /api/competitive-ff/analysis", async (identity) => {
    const { filters, group } = parseAnalysisQuery(new URL(request.url));
    return Response.json(await loadFfAnalysis(identity, filters, group));
  });
}
