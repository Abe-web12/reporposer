export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe/config";
import { getCustomerId } from "@/lib/stripe/helpers";
import { sanitizeError, AppError, parseBody } from "@/lib/utils/api-errors";
import { getBaseUrl } from "@/lib/utils";
import { rateLimit } from "@/lib/utils/rate-limit";
import { CouponEngine } from "@/lib/billing/coupons";
import { z } from "zod";

const addonCheckoutSchema = z.object({
  addonId: z.string(),
  couponCode: z.string().optional(),
  successPath: z.string().optional().default("/billing?addon=success"),
  cancelPath: z.string().optional().default("/billing?addon=cancelled"),
});

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new AppError("Unauthorized", 401);

    const limitResult = await rateLimit(`billing:addons:checkout:${user.id}`, {
      windowMs: 60000, maxRequests: 10,
    });
    if (!limitResult.success) throw new AppError("Too many requests", 429);

    const body = await parseBody<Record<string, unknown>>(request);
    const parsed = addonCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(Object.values(parsed.error.flatten().fieldErrors).flat()[0] as string || "Invalid input", 400);
    }

    const dbUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, email: true },
    });
    if (!dbUser) throw new AppError("Profile not found", 404);

    const addon = await prisma.addonProducts.findUnique({ where: { id: parsed.data.addonId } });
    if (!addon || !addon.isActive) throw new AppError("Addon not found or inactive", 404);
    if (!addon.stripePriceId) throw new AppError("Addon has no Stripe price configured", 400);

    let customerId = dbUser.stripeCustomerId;
    if (!customerId) {
      customerId = await getCustomerId(user.id, dbUser.email || user.email!);
      await prisma.users.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const stripe = getStripe();
    const baseUrl = getBaseUrl();

    const sessionParams: Record<string, unknown> = {
      customer: customerId,
      mode: "payment",
      line_items: [{ price: addon.stripePriceId, quantity: 1 }],
      success_url: `${baseUrl}${parsed.data.successPath}`,
      cancel_url: `${baseUrl}${parsed.data.cancelPath}`,
      metadata: {
        user_id: user.id,
        addon_id: parsed.data.addonId,
        type: "addon",
      },
    };

    if (parsed.data.couponCode) {
      const validation = await CouponEngine.validate(parsed.data.couponCode, {
        userId: user.id,
        amount: addon.priceCents / 100,
      });
      if (!validation.valid) throw new AppError(validation.error ?? "Invalid coupon", 400);
      sessionParams.discounts = [{ coupon: parsed.data.couponCode }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams as any);
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}
