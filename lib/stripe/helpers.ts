import { getStripe, getPriceIds } from "./config";
import { getBaseUrl } from "@/lib/utils";

const STEP_LOG_PREFIX = "[STRIPE-HELPERS]";

function stepLog(step: string, ok: boolean, detail?: string): void {
  const mark = ok ? "✓" : "✗";
  console.log(`${STEP_LOG_PREFIX} STEP ${step} ${mark}${detail ? " — " + detail : ""}`);
}

export async function createCheckoutSession({
  customerId,
  priceId,
  userId,
}: {
  customerId: string | null;
  priceId: string;
  userId: string;
}) {
  const stripe = getStripe();
  stepLog("createCheckoutSession", true, `userId=${userId}, priceId=${priceId}`);

  const session = await stripe.checkout.sessions.create({
    customer: customerId || undefined,
    customer_email: customerId ? undefined : undefined,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${getBaseUrl()}/dashboard?checkout=success`,
    cancel_url: `${getBaseUrl()}/upgrade?checkout=cancelled`,
    metadata: { user_id: userId },
    subscription_data: {
      metadata: { user_id: userId },
    },
  });

  stepLog("createCheckoutSession", true, `sessionId=${session.id}`);
  return session;
}

export async function createPortalSession(customerId: string) {
  const stripe = getStripe();
  stepLog("createPortalSession", true, `customerId=${customerId}`);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getBaseUrl()}/settings`,
  });

  stepLog("createPortalSession", true, `sessionId=${session.id}`);
  return session;
}

export function getPriceId(planKey: string): string | null {
  const ids = getPriceIds();
  if (planKey === "starter") return ids.starter;
  if (planKey === "pro") return ids.pro;
  return null;
}

export function getPlanFromPriceId(priceId: string): string | null {
  const ids = getPriceIds();
  if (priceId === ids.starter) return "starter";
  if (priceId === ids.pro) return "pro";
  return null;
}

export async function getCustomerId(userId: string, email: string): Promise<string> {
  const stripe = getStripe();
  stepLog("getCustomerId", true, `userId=${userId}, email=${email || "(empty)"}`);

  if (!email || email.trim() === "") {
    const customer = await stripe.customers.create({
      description: `User ${userId}`,
      metadata: { user_id: userId },
    });
    stepLog("getCustomerId", true, `created customer without email: ${customer.id}`);
    return customer.id;
  }

  const customers = await stripe.customers.list({ email, limit: 10 });
  const matched = customers.data.find((c) => c.metadata?.user_id === userId);
  if (matched) {
    stepLog("getCustomerId", true, `found existing customer: ${matched.id}`);
    return matched.id;
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { user_id: userId },
    description: `User ${userId}`,
  });
  stepLog("getCustomerId", true, `created customer: ${customer.id}`);
  return customer.id;
}
