export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe/config";
import { createCheckoutSession, getCustomerId, getPriceId } from "@/lib/stripe/helpers";
import { sanitizeError, AppError, parseBody } from "@/lib/utils/api-errors";
import { CouponEngine } from "@/lib/billing/coupons";
import { rateLimit } from "@/lib/utils/rate-limit";
import { getBaseUrl } from "@/lib/utils";
import { z } from "zod";

const LOG = "[BILLING_CHECKOUT]";

function log(step: string, ok: boolean, detail?: string): void {
  const mark = ok ? "✓" : "✗";
  console.log(`${LOG} STEP ${step} ${mark}${detail ? " — " + detail : ""}`);
}

const checkoutSchema = z.object({
  type: z.enum(["subscription", "addon", "lifetime"]).optional().default("subscription"),
  plan: z.string().optional(),
  addonId: z.string().optional(),
  lifetimePlanId: z.string().optional(),
  couponCode: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    log("1", true, "Starting checkout request");

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      log("2", false, "No authenticated user");
      throw new AppError("Unauthorized", 401);
    }
    log("2", true, `Clerk authenticated — userId=${user.id}`);

    const limitResult = await rateLimit(`billing:checkout:${user.id}`, {
      windowMs: 60000, maxRequests: 10,
    });
    if (!limitResult.success) {
      log("3", false, "Rate limited");
      throw new AppError("Too many requests", 429);
    }
    log("3", true, "Rate limit check passed");

    const body = await parseBody<Record<string, unknown>>(request);
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      log("4", false, `Invalid input: ${Object.values(parsed.error.flatten().fieldErrors).flat()[0]}`);
      throw new AppError(Object.values(parsed.error.flatten().fieldErrors).flat()[0] as string || "Invalid input", 400);
    }
    log("4", true, `Input validated — type=${parsed.data.type}, plan=${parsed.data.plan || "(none)"}`);

    const dbUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, email: true, plan: true },
    });
    if (!dbUser) {
      log("5", false, `User ${user.id} not found in database`);
      throw new AppError("Profile not found", 404);
    }
    log("5", true, `User loaded — plan=${dbUser.plan}, stripeCustomerId=${dbUser.stripeCustomerId || "(none)"}`);

    let customerId = dbUser.stripeCustomerId;
    if (!customerId) {
      log("6", false, "stripeCustomerId missing — creating now");
      customerId = await getCustomerId(user.id, dbUser.email || user.email!);
      await prisma.users.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
      log("7", true, `Customer created: ${customerId}`);
    } else {
      log("6", true, `stripeCustomerId exists: ${customerId}`);
      try {
        const stripe = getStripe();
        const retrievedCustomer = await stripe.customers.retrieve(customerId);
        if (retrievedCustomer.deleted) {
          log("7", false, `Customer ${customerId} deleted in Stripe — recreating`);
          customerId = await getCustomerId(user.id, dbUser.email || user.email!);
          await prisma.users.update({
            where: { id: user.id },
            data: { stripeCustomerId: customerId },
          });
          log("8", true, `Recreated customer: ${customerId}`);
        } else {
          log("7", true, `Customer verified in Stripe`);
        }
      } catch (stripeErr) {
        log("7", false, `Failed to verify customer: ${stripeErr instanceof Error ? stripeErr.message : stripeErr}`);
        customerId = await getCustomerId(user.id, dbUser.email || user.email!);
        await prisma.users.update({
          where: { id: user.id },
          data: { stripeCustomerId: customerId },
        });
        log("8", true, `Recreated customer: ${customerId}`);
      }
    }

    const stripe = getStripe();

    if (parsed.data.type === "addon") {
      if (!parsed.data.addonId) throw new AppError("addonId required", 400);
      log("8", true, `Creating addon checkout: addonId=${parsed.data.addonId}`);
      const addon = await prisma.addonProducts.findUnique({ where: { id: parsed.data.addonId } });
      if (!addon || !addon.isActive) throw new AppError("Addon not found", 404);
      if (!addon.stripePriceId) throw new AppError("Addon has no Stripe price", 400);

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "payment",
        line_items: [{ price: addon.stripePriceId, quantity: 1 }],
        success_url: `${getBaseUrl()}/billing?addon=success`,
        cancel_url: `${getBaseUrl()}/billing?addon=cancelled`,
        metadata: { user_id: user.id, addon_id: parsed.data.addonId, type: "addon" },
      });
      log("9", true, `Addon checkout session created: ${session.url}`);
      return NextResponse.json({ url: session.url });
    }

    if (parsed.data.type === "lifetime") {
      if (!parsed.data.lifetimePlanId) throw new AppError("lifetimePlanId required", 400);
      log("8", true, `Creating lifetime checkout: lifetimePlanId=${parsed.data.lifetimePlanId}`);
      const plan = await prisma.lifetimePlans.findUnique({ where: { id: parsed.data.lifetimePlanId } });
      if (!plan || !plan.isActive) throw new AppError("Lifetime plan not found", 404);

      if (plan.stripePriceId) {
        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          mode: "payment",
          line_items: [{ price: plan.stripePriceId, quantity: 1 }],
          success_url: `${getBaseUrl()}/billing?lifetime=success`,
          cancel_url: `${getBaseUrl()}/billing?lifetime=cancelled`,
          metadata: { user_id: user.id, lifetime_plan_id: parsed.data.lifetimePlanId, type: "lifetime_deal" },
        });
        log("9", true, `Lifetime checkout session created: ${session.url}`);
        return NextResponse.json({ url: session.url });
      }
      throw new AppError("Lifetime plan has no Stripe price", 400);
    }

    const plan = parsed.data.plan;
    if (!plan) throw new AppError("plan required for subscription", 400);
    const priceId = getPriceId(plan);
    if (!priceId) throw new AppError("Invalid plan", 400);
    log("8", true, `Creating subscription checkout: plan=${plan}, priceId=${priceId}`);

    const sessionParams: any = {
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${getBaseUrl()}/settings?billing=success`,
      cancel_url: `${getBaseUrl()}/upgrade?billing=cancelled`,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
    };

    if (parsed.data.couponCode) {
      const validation = await CouponEngine.validate(parsed.data.couponCode, {
        plan,
        userId: user.id,
      });
      if (!validation.valid) throw new AppError(validation.error ?? "Invalid coupon", 400);
      sessionParams.discounts = [{ coupon: parsed.data.couponCode }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    log("9", true, `Subscription checkout session created: ${session.url}`);
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error(`${LOG} ERROR:`, err instanceof Error ? err.message : err, err instanceof Error ? err.stack : "");
    const { error, status } = sanitizeError(err);
    log("FAIL", false, `Returning ${status}: ${error}`);
    return NextResponse.json({ error }, { status });
  }
}
