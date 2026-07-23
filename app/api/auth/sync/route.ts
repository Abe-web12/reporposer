export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { ensureUserSync } from "@/lib/auth/sync";
import { sanitizeError, AppError } from "@/lib/utils/api-errors";
import { rateLimitByIp } from "@/lib/utils/rate-limit";
import { sendWelcomeEmail } from "@/lib/email/sender";

export async function POST(request: Request) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rl = await rateLimitByIp(ip, { windowMs: 60_000, maxRequests: 5 });
    if (!rl.success) {
      throw new AppError("Too many requests. Please try again later.", 429);
    }

    const { userId } = await auth();
    if (!userId) {
      throw new AppError("Unauthorized", 401);
    }

    const syncResult = await ensureUserSync(userId);

    const dbUser = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        fullName: true,
        avatarUrl: true,
        plan: true,
        createdAt: true,
      },
    });

    if (syncResult.isNewUser && dbUser) {
      const displayName = dbUser.fullName || dbUser.name || dbUser.email.split("@")[0];
      sendWelcomeEmail(dbUser.email, displayName).catch(() => {});
    }

    return NextResponse.json({ user: dbUser });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}