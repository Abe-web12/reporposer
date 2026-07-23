import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ensureUserSync } from "@/lib/auth/sync";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const next = url.searchParams.get("next") || "/dashboard";

    const safeNext =
      next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

    const session = await auth();
    const userId = session?.userId;

    if (userId) {
      await ensureUserSync(userId);
    }

    return NextResponse.redirect(new URL(safeNext, url.origin));
  } catch (error) {
    console.error("[CALLBACK_ERROR]", error);
    const url = new URL(request.url);
    return NextResponse.redirect(new URL("/login?error=callback_failed", url.origin));
  }
}