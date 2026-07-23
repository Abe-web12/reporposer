import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  _stripe = new Stripe(key, {
    typescript: true,
  });
  return _stripe;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

let _priceIds: { starter: string; pro: string; business: string; enterprise: string } | null = null;
let _plansMap: Record<string, { key: string; name: string; generationsLimit: number }> | null = null;

function ensurePriceIds() {
  if (!_priceIds) {
    _priceIds = {
      starter: getRequiredEnv("STRIPE_STARTER_PRICE_ID"),
      pro: getRequiredEnv("STRIPE_PRO_PRICE_ID"),
      business: process.env.STRIPE_BUSINESS_PRICE_ID || "",
      enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID || "",
    };
  }
  return _priceIds;
}

function ensurePlansMap() {
  if (!_plansMap) {
    const ids = ensurePriceIds();
    _plansMap = {
      [ids.starter]: { key: "starter", name: "Starter", generationsLimit: 30 },
      [ids.pro]: { key: "pro", name: "Pro", generationsLimit: -1 },
    };
    if (ids.business) {
      _plansMap[ids.business] = { key: "business", name: "Business", generationsLimit: -1 };
    }
    if (ids.enterprise) {
      _plansMap[ids.enterprise] = { key: "enterprise", name: "Enterprise", generationsLimit: -1 };
    }
  }
  return _plansMap;
}

export function getPriceIds() {
  return ensurePriceIds();
}

export function getPlansMap() {
  return ensurePlansMap();
}

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

export function validateStripeConfig(): void {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  ensurePriceIds();
}

export function resetStripeInstance(): void {
  _stripe = null;
}
