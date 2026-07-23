import { prisma } from "@/lib/prisma";
import { Redis } from "@upstash/redis";
import { redis } from "@/lib/redis";

export class CustomerHealthScorer {
  static async compute(userId: string): Promise<{
    healthScore: number;
    churnRisk: "low" | "medium" | "high";
    factors: Record<string, number>;
  }> {
    const [user, generations, publishes, subscriptions, invoices, supportTickets, lastSession] =
      await Promise.all([
        prisma.users.findUnique({
          where: { id: userId },
          select: { plan: true, createdAt: true, generationsUsed: true, generationsLimit: true },
        }),
        prisma.generations.count({ where: { userId } }),
        prisma.scheduledPosts.count({ where: { userId, publishedAt: { not: null } } }),
        prisma.subscriptions.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, plan: true, currentPeriodEnd: true },
        }),
        prisma.invoices.aggregate({
          where: { userId, status: "PAID" },
          _sum: { amount: true },
        }),
        prisma.supportTickets.count({ where: { userId } }),
        redis.get(`session:last:${userId}`),
      ]);

    if (!user) throw new Error("User not found");

    const daysSinceCreated = Math.max(1, Math.floor((Date.now() - user.createdAt.getTime()) / 86400000));
    const daysSinceLastLogin = lastSession
      ? Math.floor((Date.now() - Number(lastSession)) / 86400000)
      : daysSinceCreated;

    const sub = subscriptions[0];
    const billingStatus = sub?.status === "ACTIVE" ? "ok" : sub?.status === "PAST_DUE" ? "warning" : "critical";

    const totalRevenue = ((invoices._sum.amount ?? 0) + (sub?.plan === "pro" ? 4900 : sub?.plan === "starter" ? 1900 : 0)) / 100;

    const usageFrequency = Math.min(1, generations / Math.max(1, daysSinceCreated) / 2);
    const retentionScore = Math.min(1, Math.min(daysSinceCreated, 90) / 90);
    const billingScore = billingStatus === "ok" ? 1 : billingStatus === "warning" ? 0.5 : 0;
    const supportScore = Math.min(1, Math.max(0, 1 - supportTickets / 20));
    const recentActivity = daysSinceLastLogin < 7 ? 1 : daysSinceLastLogin < 30 ? 0.7 : daysSinceLastLogin < 60 ? 0.4 : 0.1;

    const factors = {
      usageFrequency: Math.round(usageFrequency * 100),
      retentionScore: Math.round(retentionScore * 100),
      billingScore: Math.round(billingScore * 100),
      supportScore: Math.round(supportScore * 100),
      recentActivity: Math.round(recentActivity * 100),
    };

    const healthScore = Math.round(
      usageFrequency * 0.25 +
      retentionScore * 0.20 +
      billingScore * 0.25 +
      supportScore * 0.10 +
      recentActivity * 0.20
    );

    let churnRisk: "low" | "medium" | "high";
    if (healthScore >= 70) churnRisk = "low";
    else if (healthScore >= 40) churnRisk = "medium";
    else churnRisk = "high";

    const planPrices: Record<string, number> = { free: 0, starter: 1900, pro: 4900, business: 14900, enterprise: 49900 };
    const mrr = planPrices[user.plan] ?? 0;

    await prisma.customerHealth.upsert({
      where: { userId },
      create: {
        userId,
        plan: user.plan,
        mrr: mrr / 100,
        lifetimeValue: totalRevenue,
        daysActive: daysSinceCreated,
        daysSinceLastLogin,
        totalGenerations: generations,
        totalPublishes: publishes,
        supportTickets,
        billingStatus,
        healthScore,
        churnRisk,
        metadata: { factors } as any,
      },
      update: {
        plan: user.plan,
        mrr: mrr / 100,
        lifetimeValue: totalRevenue,
        daysActive: daysSinceCreated,
        daysSinceLastLogin,
        totalGenerations: generations,
        totalPublishes: publishes,
        supportTickets,
        billingStatus,
        healthScore,
        churnRisk,
        metadata: { factors } as any,
        lastCalculatedAt: new Date(),
      },
    });

    return { healthScore, churnRisk, factors };
  }

  static async get(userId: string): Promise<any> {
    const health = await prisma.customerHealth.findUnique({ where: { userId } });
    if (!health) return this.compute(userId);
    const staleThreshold = Date.now() - 86400000;
    if (health.lastCalculatedAt.getTime() < staleThreshold) {
      return this.compute(userId);
    }
    return health;
  }

  static async getAtRiskUsers(riskLevel?: "high" | "medium", limit: number = 50): Promise<any[]> {
    return prisma.customerHealth.findMany({
      where: {
        ...(riskLevel ? { churnRisk: riskLevel } : { churnRisk: { in: ["medium", "high"] } }),
      },
      orderBy: { healthScore: "asc" },
      take: limit,
    });
  }

  static async getSegmentSizes(): Promise<{
    healthy: number;
    atRisk: number;
    churned: number;
    total: number;
  }> {
    const [healthy, atRisk, churned] = await Promise.all([
      prisma.customerHealth.count({ where: { churnRisk: "low" } }),
      prisma.customerHealth.count({ where: { churnRisk: { in: ["medium", "high"] } } }),
      prisma.customerHealth.count({ where: { healthScore: { lt: 20 } } }),
    ]);
    return { healthy, atRisk, churned, total: healthy + atRisk + churned };
  }
}
