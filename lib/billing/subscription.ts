import { prisma } from "@/lib/prisma";
import { getStripe, getPriceIds, getPlansMap } from "@/lib/stripe/config";
import { getBaseUrl } from "@/lib/utils";

export class SubscriptionManager {
  static async syncFromStripe(userId: string): Promise<void> {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user?.stripeSubscriptionId) return;

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId) as any;

    await prisma.subscriptions.upsert({
      where: { stripeId: sub.id },
      create: {
        userId,
        stripeId: sub.id,
        stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
        plan: sub.items.data[0]?.price.id
          ? this.mapPriceIdToPlan(sub.items.data[0].price.id)
          : user.plan,
        status: this.mapStatus(sub.status) as any,
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null,
        trialStart: sub.trial_start ? new Date(sub.trial_start * 1000) : null,
        trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
        metadata: { syncedAt: new Date().toISOString() } as any,
      },
      update: {
        stripePriceId: sub.items.data[0]?.price.id ?? null,
        plan: this.mapPriceIdToPlan(sub.items.data[0]?.price.id ?? ""),
        status: this.mapStatus(sub.status) as any,
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
      },
    });
  }

  static async updatePlan(userId: string, plan: string, stripeSubscriptionId?: string): Promise<void> {
    const planLimits: Record<string, number> = { free: 3, starter: 30, pro: -1, business: -1, enterprise: -1 };
    const limit = planLimits[plan] ?? 3;

    await prisma.users.update({
      where: { id: userId },
      data: {
        plan,
        generationsLimit: limit,
        ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      },
    });
  }

  static async cancelSubscription(userId: string, atPeriodEnd: boolean = true): Promise<void> {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user?.stripeSubscriptionId) throw new Error("No active subscription");

    const stripe = getStripe();
    if (atPeriodEnd) {
      await stripe.subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
    }

    await prisma.subscriptions.updateMany({
      where: { userId, status: "ACTIVE" },
      data: { cancelAtPeriodEnd: atPeriodEnd, status: atPeriodEnd ? "ACTIVE" : "CANCELED" },
    });

    await prisma.subscriptionEvents.create({
      data: {
        userId,
        eventType: atPeriodEnd ? "subscription_cancelled_at_period_end" : "subscription_canceled",
        metadata: { atPeriodEnd } as any,
      },
    });
  }

  static async changePlan(userId: string, newPlan: string, couponCode?: string): Promise<{ url?: string }> {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const priceId = this.getPriceIdForPlan(newPlan);
    if (!priceId) throw new Error(`No price ID for plan: ${newPlan}`);

    let couponId: string | undefined;
    if (couponCode) {
      const { CouponEngine } = await import("./coupons");
      const validation = await CouponEngine.validate(couponCode, { plan: newPlan, userId });
      if (!validation.valid) throw new Error(validation.error ?? "Invalid coupon");
      couponId = validation.coupon?.id;
    }

    const stripe = getStripe();

    if (user.stripeSubscriptionId) {
      const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      const items = sub.items.data.map((item) => ({
        id: item.id,
        price: priceId,
      }));

      const updateParams: any = {
        items,
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      };

      if (couponId) {
        const coupon = await prisma.coupons.findUnique({ where: { id: couponId } });
        if (coupon) {
          updateParams.coupon = coupon.code;
        }
      }

      await stripe.subscriptions.update(user.stripeSubscriptionId, updateParams);
      await this.syncFromStripe(userId);
    } else {
      const baseUrl = getBaseUrl();
      const couponCode = couponId ? (await prisma.coupons.findUnique({ where: { id: couponId } }))?.code : undefined;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        ...(couponCode ? {
          discounts: [{ coupon: couponCode }],
        } : {}),
        success_url: `${baseUrl}/settings?billing=success`,
        cancel_url: `${baseUrl}/upgrade?billing=cancelled`,
        metadata: { user_id: userId },
        subscription_data: { metadata: { user_id: userId } },
      });
      return { url: session.url ?? undefined };
    }

    return {};
  }

  static async getActiveSubscription(userId: string): Promise<any | null> {
    return prisma.subscriptions.findFirst({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  }

  static async getSubscriptionHistory(userId: string): Promise<any[]> {
    return prisma.subscriptionEvents.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  static async resumeSubscription(userId: string): Promise<void> {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user?.stripeSubscriptionId) throw new Error("No subscription found");

    const stripe = getStripe();
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    await prisma.subscriptions.updateMany({
      where: { userId, cancelAtPeriodEnd: true },
      data: { cancelAtPeriodEnd: false },
    });

    await prisma.subscriptionEvents.create({
      data: {
        userId,
        eventType: "subscription_resumed",
        metadata: { resumedAt: new Date().toISOString() } as any,
      },
    });
  }

  static async getProrationPreview(userId: string, newPlan: string): Promise<{
    prorationDate: number;
    immediateAmount: number;
    nextPaymentAmount: number;
    periodStart: number;
    periodEnd: number;
  } | null> {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user?.stripeSubscriptionId) return null;

    const priceId = this.getPriceIdForPlan(newPlan);
    if (!priceId) throw new Error(`No price ID for plan: ${newPlan}`);

    const stripe = getStripe();
    const items = [{
      id: (await stripe.subscriptions.retrieve(user.stripeSubscriptionId)).items.data[0].id,
      price: priceId,
    }];

    const invoice = await (stripe.invoices as any).retrieveUpcoming({
      subscription: user.stripeSubscriptionId,
      subscription_items: items,
    });

    return {
      prorationDate: Date.now(),
      immediateAmount: invoice.amount_due,
      nextPaymentAmount: invoice.amount_remaining,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
    };
  }

  static async listAll(options?: { status?: string; plan?: string; limit?: number; offset?: number }): Promise<{ subscriptions: any[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (options?.status) where.status = options.status;
    if (options?.plan) where.plan = options.plan;

    const [subscriptions, total] = await Promise.all([
      prisma.subscriptions.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: options?.limit ?? 50,
        skip: options?.offset ?? 0,
      }),
      prisma.subscriptions.count({ where }),
    ]);

    return { subscriptions, total };
  }

  private static mapStatus(stripeStatus: string): string {
    const map: Record<string, string> = {
      active: "ACTIVE", past_due: "PAST_DUE", canceled: "CANCELED",
      unpaid: "PAST_DUE", trialing: "TRIALING", incomplete: "PAST_DUE",
      incomplete_expired: "EXPIRED", paused: "PAUSED",
    };
    return map[stripeStatus] ?? "ACTIVE";
  }

  private static mapPriceIdToPlan(priceId: string): string {
    const ids = getPriceIds();
    if (priceId === ids.starter) return "starter";
    if (priceId === ids.pro) return "pro";
    if (priceId === process.env.STRIPE_BUSINESS_PRICE_ID) return "business";
    if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) return "enterprise";
    return "free";
  }

  private static getPriceIdForPlan(plan: string): string | null {
    const ids = getPriceIds();
    if (plan === "starter") return ids.starter;
    if (plan === "pro") return ids.pro;
    if (plan === "business") return process.env.STRIPE_BUSINESS_PRICE_ID ?? null;
    if (plan === "enterprise") return process.env.STRIPE_ENTERPRISE_PRICE_ID ?? null;
    return null;
  }
}
