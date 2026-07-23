import { prisma } from "@/lib/prisma";
import { CreditManager } from "./credits";
import { getStripe } from "@/lib/stripe/config";
import { getBaseUrl } from "@/lib/utils";

export class AddonManager {
  static async purchaseCreditsAddon(
    userId: string,
    addonId: string,
    options?: { couponCode?: string },
  ): Promise<{ sessionUrl?: string; direct?: { credits: number; balance: number } }> {
    const addon = await prisma.addonProducts.findUnique({ where: { id: addonId } });
    if (!addon || !addon.isActive) throw new Error("Addon not found or inactive");

    const creditsAmount = addon.creditsAmount ?? 0;

    let finalAmount = addon.priceCents;
    if (options?.couponCode) {
      const { CouponEngine } = await import("./coupons");
      const validation = await CouponEngine.validate(options.couponCode, {
        userId,
        amount: finalAmount / 100,
      });
      if (validation.valid && validation.discountAmount) {
        finalAmount = Math.max(0, finalAmount - Math.round(validation.discountAmount * 100));
      }
    }

    if (addon.stripePriceId) {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: addon.stripePriceId, quantity: 1 }],
        success_url: `${getBaseUrl()}/billing?addon=success`,
        cancel_url: `${getBaseUrl()}/billing?addon=cancelled`,
        metadata: { user_id: userId, addon_id: addonId, type: "addon" },
      });
      return { sessionUrl: session.url ?? undefined };
    }

    const result = await CreditManager.addCredits(userId, creditsAmount, "ADDON", {
      reference: `addon:${addonId}`,
      description: `Purchased: ${addon.name}`,
    });

    await prisma.userAddons.create({
      data: {
        userId,
        addonId,
        creditsAdded: creditsAmount,
        amountPaid: finalAmount,
        metadata: {} as any,
      },
    });

    return { direct: { credits: creditsAmount, balance: result.balance } };
  }

  static async listAvailable(userId?: string): Promise<any[]> {
    const addons = await prisma.addonProducts.findMany({
      where: { isActive: true },
      orderBy: { priceCents: "asc" },
    });

    if (!userId) return addons;

    const purchased = await prisma.userAddons.findMany({
      where: { userId },
      select: { addonId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const purchasedMap = new Map(purchased.map((p) => [p.addonId, p.createdAt]));

    return addons.map((a) => ({
      ...a,
      purchased: purchasedMap.has(a.id),
      purchasedAt: purchasedMap.get(a.id) ?? null,
    }));
  }

  static async getPurchaseHistory(userId: string): Promise<any[]> {
    return prisma.userAddons.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { addon: true },
    });
  }
}
