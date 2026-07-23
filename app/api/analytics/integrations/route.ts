export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAnalyticsAccess } from "@/lib/analytics/auth";
import { cacheGet, cacheKey } from "@/lib/utils/cache";
import { queryHandler } from "@/lib/api/shared-middleware";
import { AppError } from "@/lib/utils/api-errors";
import { subDays, startOfDay, format } from "date-fns";

export const GET = queryHandler({
  rateLimit: { windowMs: 60_000, maxRequests: 30 },
  name: "analytics.integrations.list",
  handler: async (request, ctx) => {
    const orgId = ctx.orgId;
    if (!orgId) throw new AppError("No organization found", 404);
    await requireAnalyticsAccess(orgId);

    const { searchParams } = new URL(request.url);
    const days = Math.min(Math.max(parseInt(searchParams.get("days") || "30"), 7), 365);

    const data = await cacheGet(cacheKey("analytics", "integrations", orgId, `${days}`), async () => {
      const startDate = startOfDay(subDays(new Date(), days));

      const [installed, webhookLogs] = await Promise.all([
        prisma.installedIntegrations.findMany({
          where: { organizationId: orgId },
          select: { id: true, integrationKey: true, status: true, createdAt: true },
        }),
        prisma.webhookDeliveries.findMany({
          where: { createdAt: { gte: startDate } },
          select: { id: true, status: true, createdAt: true },
        }),
      ]);

      const totalInstalls = installed.length;
      const activeInstalls = installed.filter((i) => i.status === "CONNECTED").length;
      const byType: Record<string, number> = {};
      for (const i of installed) {
        const key = i.integrationKey;
        byType[key] = (byType[key] ?? 0) + 1;
      }

      const dailyWebhookMap = new Map<string, { total: number; success: number; failed: number }>();
      for (let i = days; i >= 0; i--) {
        dailyWebhookMap.set(format(subDays(new Date(), i), "yyyy-MM-dd"), { total: 0, success: 0, failed: 0 });
      }

      for (const w of webhookLogs) {
        const d = format(w.createdAt, "yyyy-MM-dd");
        const entry = dailyWebhookMap.get(d);
        if (entry) {
          entry.total++;
          if (w.status === "success" || w.status === "delivered") entry.success++;
          else entry.failed++;
        }
      }

      return {
        totalInstalls,
        activeInstalls,
        byType,
        webhookActivity: Array.from(dailyWebhookMap.entries()).map(([date, stats]) => ({ date, ...stats })),
      };
    }, 300);

    return NextResponse.json({ data });
  },
});
