export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { requireAnalyticsAccess, getOrganizationId } from "@/lib/analytics/auth";
import { AnalyticsEngine } from "@/lib/analytics/engine";
import { analyticsPeriodSchema } from "@/lib/validations/analytics";
import { queryHandler } from "@/lib/api/shared-middleware";
import { AppError } from "@/lib/utils/api-errors";

export const GET = queryHandler({
  rateLimit: { windowMs: 60_000, maxRequests: 30 },
  name: "analytics.users.list",
  handler: async (request, ctx) => {
    const orgId = ctx.orgId;
    if (!orgId) throw new AppError("No organization found", 404);
    await requireAnalyticsAccess(orgId);

    const { searchParams } = new URL(request.url);

    const { period } = analyticsPeriodSchema.parse({
      period: searchParams.get("period") ?? "30d",
    });
    const days = period === "7d" ? 7 : period === "90d" ? 90 : period === "365d" ? 365 : 30;

    const [customerData, segments, retentionRate] = await Promise.all([
      AnalyticsEngine.getCustomerData(orgId, days),
      AnalyticsEngine.getCustomerSegments(orgId),
      AnalyticsEngine.getRetentionRate(orgId, days),
    ]);

    return NextResponse.json({
      data: {
        growth: customerData,
        segments,
        retentionRate,
      },
    });
  },
});
