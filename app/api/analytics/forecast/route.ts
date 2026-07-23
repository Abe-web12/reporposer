export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { requireAnalyticsAccess, getOrganizationId } from "@/lib/analytics/auth";
import { PredictionEngine } from "@/lib/analytics/predictions";
import { predictionSchema } from "@/lib/validations/analytics";
import { queryHandler } from "@/lib/api/shared-middleware";
import { AppError } from "@/lib/utils/api-errors";

export const GET = queryHandler({
  rateLimit: { windowMs: 60_000, maxRequests: 30 },
  name: "analytics.forecast.list",
  handler: async (request, ctx) => {
    const orgId = ctx.orgId;
    if (!orgId) throw new AppError("No organization found", 404);
    await requireAnalyticsAccess(orgId);

    const { searchParams } = new URL(request.url);
    const { metric, days, period } = predictionSchema.parse({
      metric: searchParams.get("metric") ?? "revenue",
      days: searchParams.get("days") ?? "30",
      period: searchParams.get("period") ?? "90d",
    });

    const result = await PredictionEngine.forecast({
      organizationId: orgId,
      metric,
      days: parseInt(days),
      period: period === "7d" ? 7 : period === "30d" ? 30 : period === "365d" ? 365 : 90,
    });

    return NextResponse.json({ data: result });
  },
});
