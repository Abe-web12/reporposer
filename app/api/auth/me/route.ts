export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { ensureUserSync } from "@/lib/auth/sync";
import { sanitizeError } from "@/lib/utils/api-errors";
import { rateLimitByUser } from "@/lib/utils/rate-limit";

const userSelect = {
  id: true,
  email: true,
  name: true,
  fullName: true,
  avatarUrl: true,
  plan: true,
  generationsUsed: true,
  generationsLimit: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimitByUser(userId, { windowMs: 60_000, maxRequests: 30 });
    if (!rl.success) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const syncResult = await ensureUserSync(userId);

    const dbUser = await prisma.users.findUnique({
      where: { id: userId },
      select: userSelect,
    });

    if (!dbUser) {
      return NextResponse.json({ error: "Failed to find or create user" }, { status: 500 });
    }

    return NextResponse.json({
      user: dbUser,
      organizationId: syncResult.organizationId,
    });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}