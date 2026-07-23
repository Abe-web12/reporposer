export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, STRIPE_WEBHOOK_SECRET, getPlansMap, validateStripeConfig } from "@/lib/stripe/config";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { sanitizeError, AppError } from "@/lib/utils/api-errors";
import { CreditManager } from "@/lib/billing/credits";
import { activateDeal } from "@/lib/billing/lifetime";
import { RevenueAnalytics } from "@/lib/billing/revenue";
import { NotificationService } from "@/lib/notifications";
import { rateLimit } from "@/lib/utils/rate-limit";
import type { InvoiceStatus } from "@prisma/client";

const WEBHOOK_TTL = 86400;

const SUBSCRIPTION_STATUS_MAP: Record<string, string | null> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "incomplete_expired",
};

function getPlanForSubscription(sub: Stripe.Subscription): { key: string; generationsLimit: number } | null {
  const priceId = sub.items.data[0]?.price.id;
  return priceId ? getPlansMap()[priceId] || null : null;
}

async function updateUserPlan(subscriptionId: string, eventType: string, sub: Stripe.Subscription) {
  const user = await prisma.users.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    select: { id: true, plan: true },
  });

  if (!user) return;

  const status = sub.status;

  if (status === "active" || status === "trialing") {
    const planData = getPlanForSubscription(sub);
    if (planData) {
      await prisma.users.update({
        where: { id: user.id },
        data: {
          plan: planData.key,
          generationsLimit: planData.generationsLimit,
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: sub.customer as string,
        },
      });
    }
  } else if (status === "past_due" || status === "unpaid") {
    await prisma.users.update({
      where: { id: user.id },
      data: {
        plan: user.plan,
        generationsLimit: (await prisma.users.findUnique({ where: { id: user.id }, select: { generationsLimit: true } }))?.generationsLimit ?? 3,
      },
    });
  } else {
    await prisma.users.update({
      where: { id: user.id },
      data: {
        plan: "free",
        generationsLimit: 3,
        stripeSubscriptionId: null,
      },
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    validateStripeConfig();

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")
      || "unknown";
    const limitResult = await rateLimit(`webhook:stripe:${ip}`, { windowMs: 60000, maxRequests: 30 });
    if (!limitResult.success) throw new AppError("Too many requests", 429);

    const body = await request.text();
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      throw new AppError("Missing stripe-signature header", 400);
    }

    const stripe = getStripe();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET) as Stripe.Event;
    } catch {
      throw new AppError("Invalid signature", 400);
    }

    const alreadyProcessed = await redis.get(`stripe:event:${event.id}`);
    if (alreadyProcessed) {
      return NextResponse.json({ received: true, deduplicated: true });
    }
    await redis.set(`stripe:event:${event.id}`, "1", { ex: WEBHOOK_TTL });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        const customerId = session.customer as string;

        if (!userId) break;

        const sessionType = session.metadata?.type;
        const addonId = session.metadata?.addon_id;
        const lifetimePlanId = session.metadata?.lifetime_plan_id;

        if (sessionType === "addon" && addonId) {
          const addon = await prisma.addonProducts.findUnique({ where: { id: addonId } });
          if (addon?.creditsAmount) {
            await CreditManager.addCredits(userId, addon.creditsAmount, "PURCHASED", {
              reference: `addon:${addonId}`,
              description: `Purchased: ${addon.name}`,
            });
            await prisma.userAddons.create({
              data: {
                userId,
                addonId,
                creditsAdded: addon.creditsAmount,
                amountPaid: addon.priceCents,
                stripePaymentId: session.payment_intent as string ?? null,
                metadata: { sessionId: session.id } as any,
              },
            });
          }
          break;
        }

        if (sessionType === "lifetime_deal" && lifetimePlanId) {
          const plan = await prisma.lifetimePlans.findUnique({ where: { id: lifetimePlanId } });
          if (plan) {
            await activateDeal(userId, plan);
          }
          break;
        }

        const subscriptionId = session.subscription as string;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const planData = getPlanForSubscription(subscription);

        if (planData) {
          await prisma.users.update({
            where: { id: userId },
            data: {
              plan: planData.key,
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              generationsLimit: planData.generationsLimit,
            },
          });

          const subData = subscription as any;
          await prisma.subscriptions.upsert({
            where: { stripeId: subscriptionId },
            create: {
              userId,
              stripeId: subscriptionId,
              stripePriceId: subData.items?.data?.[0]?.price?.id ?? null,
              plan: planData.key,
              status: "ACTIVE",
              currentPeriodStart: subData.current_period_start ? new Date(subData.current_period_start * 1000) : null,
              currentPeriodEnd: subData.current_period_end ? new Date(subData.current_period_end * 1000) : null,
              metadata: {} as any,
            },
            update: {
              status: "ACTIVE",
              stripePriceId: subData.items?.data?.[0]?.price?.id ?? null,
              currentPeriodStart: subData.current_period_start ? new Date(subData.current_period_start * 1000) : null,
              currentPeriodEnd: subData.current_period_end ? new Date(subData.current_period_end * 1000) : null,
            },
          });

          await prisma.subscriptionEvents.create({
            data: {
              userId,
              eventType: "subscription_created",
              newPlan: planData.key,
              amount: subData.items?.data?.[0]?.price?.unit_amount ?? null,
              metadata: { sessionId: session.id } as any,
            },
          });
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subRaw = (invoice as any).subscription;
        const subscriptionId2 = typeof subRaw === "string" ? subRaw : subRaw?.id ? String(subRaw.id) : null;

        if (!subscriptionId2) break;

        const user2 = await prisma.users.findFirst({
          where: { stripeSubscriptionId: subscriptionId2 },
          select: { id: true },
        });

        if (user2) {
          const sub2 = await stripe.subscriptions.retrieve(subscriptionId2);
          const planData2 = getPlanForSubscription(sub2);

          if (planData2 && invoice.status === "paid") {
            await prisma.users.update({
              where: { id: user2.id },
              data: {
                plan: planData2.key,
                generationsLimit: planData2.generationsLimit,
              },
            });

            const sub2Data = sub2 as any;
            await prisma.subscriptions.upsert({
              where: { stripeId: subscriptionId2 },
              create: {
                userId: user2.id,
                stripeId: subscriptionId2,
                stripePriceId: sub2Data.items?.data?.[0]?.price?.id ?? null,
                plan: planData2.key,
                status: "ACTIVE",
                currentPeriodStart: sub2Data.current_period_start ? new Date(sub2Data.current_period_start * 1000) : null,
                currentPeriodEnd: sub2Data.current_period_end ? new Date(sub2Data.current_period_end * 1000) : null,
                metadata: {} as any,
              },
              update: {
                plan: planData2.key,
                status: "ACTIVE",
                currentPeriodStart: sub2Data.current_period_start ? new Date(sub2Data.current_period_start * 1000) : null,
                currentPeriodEnd: sub2Data.current_period_end ? new Date(sub2Data.current_period_end * 1000) : null,
              },
            });

            await prisma.subscriptionEvents.create({
              data: {
                userId: user2.id,
                subscriptionId: subscriptionId2,
                eventType: "invoice_paid",
                amount: invoice.total,
                currency: invoice.currency,
                metadata: { invoiceId: invoice.id } as any,
              },
            });
          }
        }

        const invoiceStatus: InvoiceStatus = invoice.status === "paid" ? "PAID" : invoice.status === "open" ? "OPEN" : invoice.status === "draft" ? "DRAFT" : invoice.status === "void" ? "VOID" : "OPEN";

        if (invoice.id) {
          await prisma.invoices.upsert({
            where: { stripeInvoiceId: invoice.id },
            create: {
              stripeInvoiceId: invoice.id,
              stripeCustomerId: invoice.customer as string,
              subscriptionId: subscriptionId2,
              amount: invoice.total,
              currency: invoice.currency,
              status: invoiceStatus,
              hostedInvoiceUrl: invoice.hosted_invoice_url,
              pdfUrl: invoice.invoice_pdf,
              periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
              periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
              paidAt: invoice.status === "paid" ? new Date() : null,
              userId: user2?.id || "",
            },
            update: {
              status: invoiceStatus,
              amount: invoice.total,
              hostedInvoiceUrl: invoice.hosted_invoice_url,
              pdfUrl: invoice.invoice_pdf,
              paidAt: invoice.status === "paid" ? new Date() : null,
            },
          });
        }
        break;
      }

      case "invoice.payment_failed": {
        const failedInvoice = event.data.object as Stripe.Invoice;
        const subFailRaw = (failedInvoice as any).subscription;
        const subId3 = typeof subFailRaw === "string" ? subFailRaw : subFailRaw?.id ? String(subFailRaw.id) : null;

        if (subId3) {
          const user3 = await prisma.users.findFirst({
            where: { stripeSubscriptionId: subId3 },
            select: { id: true },
          });
          if (user3) {
            await prisma.invoices.upsert({
              where: { stripeInvoiceId: failedInvoice.id },
              create: {
                stripeInvoiceId: failedInvoice.id,
                stripeCustomerId: failedInvoice.customer as string,
                subscriptionId: subId3,
                amount: failedInvoice.total,
                currency: failedInvoice.currency,
                status: "OPEN",
                hostedInvoiceUrl: failedInvoice.hosted_invoice_url,
                pdfUrl: failedInvoice.invoice_pdf,
                periodStart: failedInvoice.period_start ? new Date(failedInvoice.period_start * 1000) : null,
                periodEnd: failedInvoice.period_end ? new Date(failedInvoice.period_end * 1000) : null,
                userId: user3.id,
              },
              update: {
                status: "OPEN",
                amount: failedInvoice.total,
              },
            });
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub4 = event.data.object as Stripe.Subscription;
        await updateUserPlan(sub4.id, event.type, sub4);

        const eventUserId = (await prisma.users.findFirst({
          where: { stripeSubscriptionId: sub4.id },
          select: { id: true },
        }))?.id;

        if (eventUserId) {
          const sub4Data = sub4 as any;
          const planData4 = getPlanForSubscription(sub4Data);
          const stripeStatus = sub4Data.status;
          const subStatus = stripeStatus === "active" ? "ACTIVE"
            : stripeStatus === "past_due" ? "PAST_DUE"
            : stripeStatus === "canceled" ? "CANCELED"
            : stripeStatus === "trialing" ? "TRIALING"
            : stripeStatus === "incomplete" ? "PAST_DUE" : "EXPIRED";

          await prisma.subscriptions.upsert({
            where: { stripeId: sub4Data.id },
            create: {
              userId: eventUserId,
              stripeId: sub4Data.id,
              stripePriceId: sub4Data.items?.data?.[0]?.price?.id ?? null,
              plan: planData4?.key ?? "free",
              status: subStatus as any,
              currentPeriodStart: sub4Data.current_period_start ? new Date(sub4Data.current_period_start * 1000) : null,
              currentPeriodEnd: sub4Data.current_period_end ? new Date(sub4Data.current_period_end * 1000) : null,
              cancelAtPeriodEnd: sub4Data.cancel_at_period_end,
              canceledAt: sub4Data.canceled_at ? new Date(sub4Data.canceled_at * 1000) : null,
              metadata: {} as any,
            },
            update: {
              stripePriceId: sub4Data.items?.data?.[0]?.price?.id ?? null,
              plan: planData4?.key ?? "free",
              status: subStatus as any,
              currentPeriodStart: sub4Data.current_period_start ? new Date(sub4Data.current_period_start * 1000) : null,
              currentPeriodEnd: sub4Data.current_period_end ? new Date(sub4Data.current_period_end * 1000) : null,
              cancelAtPeriodEnd: sub4Data.cancel_at_period_end,
              canceledAt: sub4Data.canceled_at ? new Date(sub4Data.canceled_at * 1000) : null,
            },
          });

          await prisma.subscriptionEvents.create({
            data: {
              userId: eventUserId,
              subscriptionId: sub4Data.id,
              eventType: event.type.replace("customer.subscription.", "subscription_"),
              newPlan: planData4?.key ?? null,
              metadata: { status: sub4.status } as any,
            },
          });
        }
        break;
      }

      case "charge.refunded": {
        const refund = event.data.object as Stripe.Charge;
        const refundAmount = (refund.amount_refunded ?? 0) / 100;
        if (refundAmount > 0) {
          await RevenueAnalytics.recordRefund(refund.id, refundAmount);
        }
        break;
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        const connectRecord = await prisma.stripeConnectAccounts.findFirst({
          where: { stripeAccountId: account.id },
        });
        if (connectRecord) {
          const wasEnabled = connectRecord.chargesEnabled && connectRecord.payoutsEnabled;
          const isEnabled = account.charges_enabled && account.payouts_enabled;

          await prisma.stripeConnectAccounts.update({
            where: { id: connectRecord.id },
            data: {
              chargesEnabled: account.charges_enabled,
              payoutsEnabled: account.payouts_enabled,
              detailsSubmitted: account.details_submitted,
              status: account.details_submitted ? "ACTIVE" : "PENDING",
              updatedAt: new Date(),
            },
          });

          if (!wasEnabled && isEnabled) {
            await NotificationService.notifyBilling(
              connectRecord.developerId,
              "Stripe Connect account approved",
              "Your Stripe Connect account has been fully verified. You can now receive payments for marketplace listings."
            );
          }
        }
        break;
      }

      case "payout.paid": {
        const payout = event.data.object as Stripe.Payout;
        const payoutAccount = await prisma.stripeConnectAccounts.findFirst({
          where: { stripeAccountId: payout.destination as string },
        });

        if (payoutAccount) {
          await prisma.stripeConnectAccounts.update({
            where: { id: payoutAccount.id },
            data: { totalPayoutCents: { increment: payout.amount } },
          });

          await NotificationService.notifyBilling(
            payoutAccount.developerId,
            "Payout sent",
            `A payout of $${(payout.amount / 100).toFixed(2)} has been sent to your bank account.`
          );
        }
        break;
      }

      case "payout.failed": {
        const failedPayout = event.data.object as Stripe.Payout;
        const failedAccount = await prisma.stripeConnectAccounts.findFirst({
          where: { stripeAccountId: failedPayout.destination as string },
        });

        if (failedAccount) {
          await NotificationService.notifyBilling(
            failedAccount.developerId,
            "Payout failed",
            `A payout of $${(failedPayout.amount / 100).toFixed(2)} failed. Reason: ${failedPayout.failure_message || "Unknown error"}. Please update your bank account details.`
          );
        }
        break;
      }
    }

    try {
      await RevenueAnalytics.computeDailyMetrics();
    } catch {
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}
