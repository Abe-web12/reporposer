export type EnvCheckGroup = {
  label: string;
  allOf?: string[];
  oneOf?: string[][];
};

export type EnvCheckResponse = {
  error: "Configuration Error";
  missingKeys: string[];
  message: string;
};

const LABEL_MAP: Record<string, string> = {
  STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY",
  CLERK_SECRET_KEY: "CLERK_SECRET_KEY",
  DATABASE_URL: "DATABASE_URL",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY",
  AI_API_KEY: "AI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  GOOGLE_API_KEY: "GOOGLE_API_KEY",
  GEMINI_API_KEY: "GEMINI_API_KEY",
  MISTRAL_API_KEY: "MISTRAL_API_KEY",
  GROQ_API_KEY: "GROQ_API_KEY",
};

function missingLabel(key: string): string {
  return LABEL_MAP[key] || key;
}

export function checkRequired(group: EnvCheckGroup): EnvCheckResponse | null {
  const missingKeys: string[] = [];

  if (group.allOf) {
    for (const key of group.allOf) {
      if (!process.env[key]) {
        missingKeys.push(key);
      }
    }
  }

  if (group.oneOf) {
    const anyPresent = group.oneOf.some((alt) =>
      alt.some((key) => process.env[key])
    );
    if (!anyPresent) {
      for (const alt of group.oneOf) {
        for (const key of alt) {
          if (!process.env[key] && !missingKeys.includes(key)) {
            missingKeys.push(key);
          }
        }
      }
    }
  }

  if (missingKeys.length === 0) return null;

  const displayNames = missingKeys.map(missingLabel);
  const parts: string[] = [];

  for (const key of missingKeys) {
    console.error(`[ENV_CHECK] Missing required key: ${key} (${group.label})`);
    parts.push(`Missing required key: ${key}. Please set it in Vercel settings.`);
  }

  return {
    error: "Configuration Error",
    missingKeys: displayNames,
    message: `Missing required key${missingKeys.length > 1 ? "s" : ""}: ${missingKeys.join(", ")}. Please set ${missingKeys.length > 1 ? "them" : "it"} in Vercel settings.`,
  };
}

export const AI_ENV_CHECK: EnvCheckGroup = {
  label: "AI Generation",
  allOf: ["CLERK_SECRET_KEY", "DATABASE_URL"],
  oneOf: [
    ["OPENAI_API_KEY"],
    ["DEEPSEEK_API_KEY"],
    ["AI_API_KEY"],
    ["ANTHROPIC_API_KEY"],
    ["GOOGLE_API_KEY"],
    ["GEMINI_API_KEY"],
    ["MISTRAL_API_KEY"],
    ["GROQ_API_KEY"],
  ],
};

export const BILLING_ENV_CHECK: EnvCheckGroup = {
  label: "Billing/Stripe",
  allOf: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
  oneOf: [
    ["STRIPE_STARTER_PRICE_ID", "STRIPE_PRO_PRICE_ID"],
    ["STRIPE_BUSINESS_PRICE_ID", "STRIPE_ENTERPRISE_PRICE_ID"],
  ],
};
