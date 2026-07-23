import { prisma } from "@/lib/prisma";
import { CreditManager } from "./credits";
import { getStripe } from "@/lib/stripe/config";
import { getBaseUrl } from "@/lib/utils";

export class LifetimeDealManager {
  static async listAvailable(): Promise<any[]> {
    return prisma.lifetimePlans.findMany({
      where: { isActive: true },
      orderBy: { priceCents: "asc" },
    });
  }

  static async purchase(userId: string, planId: string): Promise<{ sessionUrl?: string }> {
    const plan = await prisma.lifetimePlans.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) throw new Error("Lifetime plan not found");

    const existing = await prisma.userLifetimeDeals.findUnique({
      where: { userId_lifetimePlanId: { userId, lifetimePlanId: planId } },
    });
    if (existing) throw new Error("You already own this lifetime plan");

    if (plan.stripePriceId) {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: `${getBaseUrl()}/billing?lifetime=success`,
        cancel_url: `${getBaseUrl()}/billing?lifetime=cancelled`,
        metadata: { user_id: userId, lifetime_plan_id: planId, type: "lifetime_deal" },
      });
      return { sessionUrl: session.url ?? undefined };
    }

    await activateDeal(userId, plan);
    return {};
  }

  static async getUserDeals(userId: string): Promise<any[]> {
    return prisma.userLifetimeDeals.findMany({
      where: { userId },
      orderBy: { activatedAt: "desc" },
      include: { lifetimePlan: true },
    });
  }

  static async hasActiveDeal(userId: string): Promise<{ hasDeal: boolean; planTier?: string }> {
    const deal = await prisma.userLifetimeDeals.findFirst({
      where: { userId, status: "ACTIVE" },
      include: { lifetimePlan: true },
    });
    if (!deal) return { hasDeal: false };
    return { hasDeal: true, planTier: deal.lifetimePlan.planTier };
  }
}

export async function activateDeal(userId: string, plan: any): Promise<void> {
  await prisma.userLifetimeDeals.upsert({
    where: { userId_lifetimePlanId: { userId, lifetimePlanId: plan.id } },
    create: {
      userId,
      lifetimePlanId: plan.id,
      status: "ACTIVE",
      metadata: {} as any,
    },
    update: {
      status: "ACTIVE",
    },
  });

  if (plan.creditPack > 0) {
    await CreditManager.addCredits(userId, plan.creditPack, "BONUS", {
      reference: `lifetime:${plan.id}`,
      description: `Lifetime deal bonus credits: ${plan.name}`,
    });
  }

  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (user) {
    const currentGenerationsLimit = user.generationsLimit;
    const planTier = plan.planTier;
    let newLimit = currentGenerationsLimit;

    if (planTier === "pro" || planTier === "enterprise") {
      newLimit = -1;
    } else if (planTier === "starter" && currentGenerationsLimit < 30) {
      newLimit = 30;
    }

    await prisma.users.update({
      where: { id: userId },
      data: { plan: planTier, generationsLimit: newLimit },
    });
  }

  await prisma.subscriptionEvents.create({
    data: {
      userId,
      eventType: "lifetime_activated",
      newPlan: plan.planTier,
      amount: plan.priceCents,
      metadata: { lifetimePlanName: plan.name } as any,
    },
  });
}
