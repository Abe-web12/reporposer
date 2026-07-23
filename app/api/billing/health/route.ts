import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { AppError, sanitizeError } from "@/lib/utils/api-errors";
import { CustomerHealthScorer } from "@/lib/billing/health";
import { rateLimit } from "@/lib/utils/rate-limit";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new AppError("Unauthorized", 401);

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") ?? "my-health";

    if (action === "segments") {
      const segments = await CustomerHealthScorer.getSegmentSizes();
      return NextResponse.json({ data: segments });
    }

    if (action === "at-risk") {
      const riskLevelParam = searchParams.get("risk");
      const riskLevel = riskLevelParam === "high" || riskLevelParam === "medium" ? riskLevelParam : undefined;
      const limit = parseInt(searchParams.get("limit") ?? "50");
      const users = await CustomerHealthScorer.getAtRiskUsers(riskLevel, limit);
      return NextResponse.json({ data: users });
    }

    const health = await CustomerHealthScorer.get(user.id);
    return NextResponse.json({ data: health });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}

export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new AppError("Unauthorized", 401);

    const result = await CustomerHealthScorer.compute(user.id);
    return NextResponse.json({ data: result });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    return NextResponse.json({ error }, { status });
  }
}
