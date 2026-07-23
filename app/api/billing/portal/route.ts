export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { createPortalSession, createCheckoutSession, getCustomerId, getPriceId } from "@/lib/stripe/helpers";
import { getStripe } from "@/lib/stripe/config";
import { sanitizeError, AppError } from "@/lib/utils/api-errors";
import { getBaseUrl } from "@/lib/utils";
import { checkRequired, BILLING_ENV_CHECK } from "@/lib/env-check";

const LOG = "[BILLING_PORTAL]";

function log(step: string, ok: boolean, detail?: string): void {
  const mark = ok ? "✓" : "✗";
  console.log(`${LOG} STEP ${step} ${mark}${detail ? " — " + detail : ""}`);
}

export async function POST() {
  try {
    log("1", true, "Starting billing portal request");

    const envResult = checkRequired(BILLING_ENV_CHECK);
    if (envResult) {
      log("ENV", false, envResult.message);
      return NextResponse.json(envResult, { status: 500 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user?.id) {
      log("2", false, "No authenticated user (auth() returned null)");
      return NextResponse.json(
        { error: "Unauthorized", statusCode: 401 },
        { status: 401 }
      );
    }
    log("2", true, `Clerk authenticated — userId=${user.id}, email=${user.email || user.emailAddresses?.[0]?.emailAddress || "unknown"}`);

    const dbUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, email: true, plan: true },
    });

    if (!dbUser) {
      log("3", false, `User ${user.id} not found in database`);
      throw new AppError("Profile not found — user exists in Clerk but not in database. Try signing in again.", 404);
    }
    log("3", true, `User loaded — plan=${dbUser.plan}, stripeCustomerId=${dbUser.stripeCustomerId || "(none)"}`);

    let customerId = dbUser.stripeCustomerId;

    if (!customerId) {
      log("4", false, "stripeCustomerId missing — creating now");
      const email = dbUser.email || user.emailAddresses?.[0]?.emailAddress || "";
      if (!email) {
        log("4", false, "No email available to create Stripe customer");
        throw new AppError("Unable to create Stripe customer: no email address on file", 400);
      }
      customerId = await getCustomerId(user.id, email);
      log("5", true, `Stripe customer created: ${customerId}`);

      await prisma.users.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
      log("6", true, `User record updated with stripeCustomerId=${customerId}`);
    } else {
      log("4", true, `stripeCustomerId exists: ${customerId}`);

      try {
        const stripe = getStripe();
        const retrievedCustomer = await stripe.customers.retrieve(customerId);
        if (retrievedCustomer.deleted) {
          log("5", false, `Customer ${customerId} was deleted in Stripe — recreating`);
          const email = dbUser.email || user.emailAddresses?.[0]?.emailAddress || "";
          customerId = await getCustomerId(user.id, email);
          await prisma.users.update({
            where: { id: user.id },
            data: { stripeCustomerId: customerId },
          });
          log("6", true, `Recreated customer: ${customerId}`);
        } else {
          log("5", true, `Customer verified in Stripe`);
        }
      } catch (stripeErr) {
        log("5", false, `Failed to verify customer in Stripe: ${stripeErr instanceof Error ? stripeErr.message : stripeErr}`);
        const email = dbUser.email || user.emailAddresses?.[0]?.emailAddress || "";
        customerId = await getCustomerId(user.id, email);
        await prisma.users.update({
          where: { id: user.id },
          data: { stripeCustomerId: customerId },
        });
        log("6", true, `Recreated customer after verification failure: ${customerId}`);
      }
    }

    const subscription = await prisma.subscriptions.findFirst({
      where: { userId: user.id, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    });

    if (subscription) {
      log("7", true, `Active subscription found — creating portal session`);
      const session = await createPortalSession(customerId);
      log("8", true, `Portal session created: ${session.url}`);
      return NextResponse.json({ url: session.url });
    }

    log("7", true, `No active subscription — creating checkout session`);
    const priceId = getPriceId("starter");
    if (!priceId) {
      log("8", false, "No price ID configured — redirecting to pricing page");
      return NextResponse.json({
        url: `${getBaseUrl()}/pricing`,
      });
    }
    log("8", true, `Price ID loaded: ${priceId}`);

    const session = await createCheckoutSession({
      customerId,
      priceId,
      userId: user.id,
    });
    log("9", true, `Checkout session created: ${session.url}`);
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error(`${LOG} ERROR:`, err instanceof Error ? err.message : err, err instanceof Error ? err.stack : "");
    const { error, status } = sanitizeError(err);
    log("FAIL", false, `Returning ${status}: ${error}`);
    return NextResponse.json({ error, statusCode: status }, { status });
  }
}
