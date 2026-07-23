import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export type CreditSource = "PURCHASED" | "USAGE" | "BONUS" | "REFUND" | "EXPIRED" | "ADMIN" | "REFERRAL" | "ADDON" | "PROMOTION";

const CACHE_KEY = (uid: string) => `credits:${uid}`;
const CACHE_TTL = 300;

function ensureBalance(userId: string) {
  return prisma.creditBalances.upsert({
    where: { userId },
    create: { userId, balance: 0, reserved: 0 },
    update: {},
  });
}

export class CreditManager {
  static async getBalance(userId: string): Promise<{ balance: number; reserved: number; available: number; pendingExpiration: number }> {
    const cached = await redis.get(CACHE_KEY(userId));
    if (cached && typeof cached === "object") {
      const c = cached as any;
      return { balance: c.balance, reserved: c.reserved, available: c.balance - c.reserved, pendingExpiration: c.pendingExpiration ?? 0 };
    }

    const cb = await ensureBalance(userId);

    const expiring = await prisma.creditTransactions.findMany({
      where: {
        userId,
        amount: { gt: 0 },
        expiresAt: { not: null, lte: new Date(Date.now() + 7 * 86400000) },
      },
      select: { amount: true, expiresAt: true },
    });
    const pendingExpiration = expiring.reduce((s, t) => s + Math.max(0, t.amount), 0);

    const result = { balance: cb.balance, reserved: cb.reserved, available: cb.balance - cb.reserved, pendingExpiration };

    await redis.set(CACHE_KEY(userId), result, { ex: CACHE_TTL });
    return result;
  }

  static async reserveCredits(userId: string, amount: number, reference: string): Promise<{ success: boolean; balance: number }> {
    return prisma.$transaction(async (tx) => {
      const cb = await tx.creditBalances.findUnique({ where: { userId } });
      if (!cb) throw new Error("Credit balance not found");
      if (cb.balance - cb.reserved < amount) {
        return { success: false, balance: cb.balance - cb.reserved };
      }

      await tx.creditBalances.update({
        where: { userId },
        data: { reserved: { increment: amount }, updatedAt: new Date() },
      });

      await tx.creditTransactions.create({
        data: {
          userId,
          amount: 0,
          balanceAfter: cb.balance - cb.reserved - amount,
          source: "PURCHASED" as any,
          reference: `reserved:${reference}`,
          description: `Reserved ${amount} credits for ${reference}`,
          metadata: { reservedAmount: amount, reference } as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
      return { success: true, balance: (await tx.creditBalances.findUnique({ where: { userId } }))!.balance };
    });
  }

  static async releaseReserved(userId: string, amount: number, reference: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const cb = await tx.creditBalances.findUnique({ where: { userId } });
      if (!cb || cb.reserved < amount) return;

      await tx.creditBalances.update({
        where: { userId },
        data: { reserved: { decrement: amount }, updatedAt: new Date() },
      });

      await tx.creditTransactions.create({
        data: {
          userId,
          amount: 0,
          balanceAfter: cb.balance - (cb.reserved - amount),
          source: "PURCHASED" as any,
          reference: `released:${reference}`,
          description: `Released ${amount} reserved credits for ${reference}`,
          metadata: { releasedAmount: amount, reference } as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
    });
  }

  static async commitReserved(userId: string, amount: number, reference: string, description?: string): Promise<{ balance: number }> {
    return prisma.$transaction(async (tx) => {
      const cb = await tx.creditBalances.findUnique({ where: { userId } });
      if (!cb || cb.reserved < amount) throw new Error("Cannot commit: insufficient reserved credits");

      const newBalance = cb.balance - amount;
      await tx.creditBalances.update({
        where: { userId },
        data: { balance: { decrement: amount }, reserved: { decrement: amount }, updatedAt: new Date() },
      });

      await tx.creditTransactions.create({
        data: {
          userId,
          amount: -amount,
          balanceAfter: newBalance,
          source: "USAGE" as any,
          reference: `usage:${reference}`,
          description: description ?? `Consumed ${amount} credits for ${reference}`,
          metadata: { reference } as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
      return { balance: newBalance };
    });
  }

  static async spendCredits(
    userId: string,
    amount: number,
    reference: string,
    description?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ success: boolean; balance: number }> {
    return prisma.$transaction(async (tx) => {
      const cb = await tx.creditBalances.findUnique({ where: { userId } });
      if (!cb) throw new Error("Credit balance not found for this user");

      const available = cb.balance - cb.reserved;
      if (available < amount) {
        return { success: false, balance: available };
      }

      const newBalance = cb.balance - amount;
      await tx.creditBalances.update({
        where: { userId },
        data: { balance: { decrement: amount }, updatedAt: new Date() },
      });

      await tx.creditTransactions.create({
        data: {
          userId,
          amount: -amount,
          balanceAfter: newBalance,
          source: "USAGE" as any,
          reference: `spend:${reference}`,
          description: description ?? `Spent ${amount} credits`,
          metadata: (metadata ?? {}) as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
      return { success: true, balance: newBalance };
    });
  }

  static async checkAndDeduct(
    userId: string,
    amount: number,
    reference: string,
    extra?: { model?: string; provider?: string; tokens?: number; cost?: number; generationId?: string },
  ): Promise<{ success: boolean; error?: string; balance: number }> {
    const cb = await ensureBalance(userId);
    const available = cb.balance - cb.reserved;
    if (available < amount) {
      return { success: false, error: `Insufficient credits. Need ${amount}, have ${available}. Purchase more credits to continue.`, balance: available };
    }

    return this.spendCredits(userId, amount, reference, undefined, extra as Record<string, unknown>);
  }

  static async addCredits(
    userId: string,
    amount: number,
    source: CreditSource,
    options?: { reference?: string; description?: string; expiresAt?: Date; metadata?: Record<string, unknown> },
  ): Promise<{ balance: number }> {
    return prisma.$transaction(async (tx) => {
      const cb = await tx.creditBalances.upsert({
        where: { userId },
        create: { userId, balance: amount, reserved: 0 },
        update: { balance: { increment: amount }, updatedAt: new Date() },
      });
      const newBalance = cb.balance;

      await tx.creditTransactions.create({
        data: {
          userId,
          amount,
          balanceAfter: newBalance,
          source: source as any,
          reference: options?.reference ?? null,
          description: options?.description ?? null,
          expiresAt: options?.expiresAt ?? null,
          metadata: (options?.metadata ?? {}) as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
      return { balance: newBalance };
    });
  }

  static async getHistory(
    userId: string,
    options?: { limit?: number; offset?: number; source?: string },
  ): Promise<{ transactions: any[]; total: number }> {
    const where: Record<string, unknown> = { userId };
    if (options?.source) where.source = options.source;

    const [transactions, total] = await Promise.all([
      prisma.creditTransactions.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: options?.limit ?? 50,
        skip: options?.offset ?? 0,
      }),
      prisma.creditTransactions.count({ where }),
    ]);

    return { transactions, total };
  }

  static async expireCredits(userId: string): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const expired = await tx.creditTransactions.findMany({
        where: {
          userId,
          amount: { gt: 0 },
          expiresAt: { not: null, lte: new Date() },
        },
        select: { id: true, amount: true },
      });

      if (expired.length === 0) return 0;

      const totalExpired = expired.reduce((s, t) => s + t.amount, 0);
      const cb = await tx.creditBalances.findUnique({ where: { userId } });
      const currentBalance = cb?.balance ?? 0;
      const actualExpired = Math.min(totalExpired, currentBalance);

      if (cb && actualExpired > 0) {
        await tx.creditBalances.update({
          where: { userId },
          data: { balance: { decrement: actualExpired }, updatedAt: new Date() },
        });
      }

      const newBalance = currentBalance - actualExpired;

      await tx.creditTransactions.create({
        data: {
          userId,
          amount: -actualExpired,
          balanceAfter: newBalance,
          source: "EXPIRED" as any,
          description: `${actualExpired} credits expired${actualExpired < totalExpired ? ` (${totalExpired - actualExpired} already spent)` : ""}`,
          metadata: { expiredIds: expired.map((e) => e.id), totalExpired, actualExpired } as any,
        },
      });

      await redis.del(CACHE_KEY(userId));
      return totalExpired;
    });
  }

  static async getCreditPackages(): Promise<any[]> {
    return prisma.creditPackages.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  static async getStats(userId: string): Promise<{
    totalPurchased: number;
    totalSpent: number;
    totalExpired: number;
    totalReferral: number;
  }> {
    const bySource = await prisma.creditTransactions.groupBy({
      by: ["source"],
      where: { userId },
      _sum: { amount: true },
    });

    return {
      totalPurchased: bySource.find((s) => s.source === "PURCHASED")?._sum.amount ?? 0,
      totalSpent: Math.abs(bySource.filter((s) => (s._sum.amount ?? 0) < 0).reduce((a, b) => a + Math.abs(b._sum.amount ?? 0), 0)),
      totalExpired: Math.abs(bySource.find((s) => s.source === "EXPIRED")?._sum.amount ?? 0),
      totalReferral: bySource.find((s) => s.source === "REFERRAL")?._sum.amount ?? 0,
    };
  }
}
