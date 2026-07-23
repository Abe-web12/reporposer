export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { generateSchema } from "@/lib/validations/generate";
import { generateContentStream } from "@/lib/ai/generate";
import { canGenerate } from "@/lib/constants/plans";
import { sanitizeError, AppError, parseBody } from "@/lib/utils/api-errors";
import { rateLimitByUser } from "@/lib/utils/rate-limit";
import { CreditManager } from "@/lib/billing/credits";
import { checkRequired, AI_ENV_CHECK } from "@/lib/env-check";

const PROVIDER_TIMEOUT_MS = 60000;

export async function POST(request: NextRequest) {
  try {
    const envResult = checkRequired(AI_ENV_CHECK);
    if (envResult) {
      return NextResponse.json(envResult, { status: 500 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user?.id) {
      return NextResponse.json(
        { error: "Unauthorized", statusCode: 401 },
        { status: 401 }
      );
    }

    const limitResult = await rateLimitByUser(user.id, { windowMs: 60000, maxRequests: 10 });
    if (!limitResult.success) {
      throw new AppError("Too many requests. Please slow down.", 429);
    }

    const dbUser = await prisma.users.findUnique({ where: { id: user.id } });
    if (!dbUser) throw new AppError("Profile not found", 404);

    if (!canGenerate(dbUser.plan as any, dbUser.generationsUsed)) {
      throw new AppError("Generation limit reached. Upgrade your plan for more.", 403);
    }

    const creditReserve = await CreditManager.reserveCredits(user.id, 1, `generate:${crypto.randomUUID()}`);
    if (!creditReserve.success) {
      throw new AppError("Insufficient credits. Purchase more credits to continue.", 402);
    }

    const body = await parseBody<Record<string, unknown>>(request);
    const validation = generateSchema.safeParse(body);

    if (!validation.success) {
      throw new AppError(Object.values(validation.error.flatten().fieldErrors).flat()[0] as string || "Invalid input", 400);
    }

    const { content, output_format, voice_profile_id } = validation.data;

    let voice = null;

    if (voice_profile_id) {
      const vp = await prisma.voiceProfiles.findFirst({
        where: { id: voice_profile_id, userId: user.id },
      });
      if (vp) {
        voice = {
          id: vp.id,
          user_id: vp.userId,
          name: vp.name,
          description: vp.description,
          tone: (vp.tone || "casual") as "formal" | "casual" | "witty" | "authoritative" | "friendly",
          example_posts: vp.examplePosts,
          embedding: null,
          is_default: vp.isDefault,
          is_favorite: vp.isFavorite || false,
          created_at: vp.createdAt.toISOString(),
        };
      }
    }

    const brandKit = await prisma.brandKits.findFirst({
      where: { userId: user.id },
    });

    const brandKitContext = brandKit ? {
      company_name: brandKit.companyName,
      company_description: brandKit.companyDescription,
      target_audience: brandKit.targetAudience,
      brand_voice: brandKit.brandVoice,
      brand_colors: brandKit.brandColors,
    } : null;

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        let fullContent = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Generation timed out. Please try again." })}\n\n`));
          try { controller.close(); } catch {}
        }, PROVIDER_TIMEOUT_MS);

        try {
          const stream = await generateContentStream(output_format, content, voice, brandKitContext);

          for await (const chunk of stream) {
            if (timedOut) return;
            const text = chunk.text();
            fullContent += text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }

          clearTimeout(timer);

          if (!fullContent) {
            await CreditManager.releaseReserved(user.id, 1, `generate:empty`);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "No content generated" })}\n\n`));
            return;
          }

          const result = await prisma.$transaction(async (tx) => {
            const generation = await tx.generations.create({
              data: {
                userId: user.id,
                content: fullContent,
                inputType: "raw_text",
                inputContent: content.slice(0, 500),
                extractedContent: content,
                outputFormat: output_format,
                outputContent: fullContent,
                voiceProfileId: voice_profile_id || null,
                modelUsed: process.env.AI_MODEL || "gemini-1.5-flash",
                isFavorite: false,
              },
              select: { id: true },
            });

            await tx.usageLog.create({
              data: {
                userId: user.id,
                generationId: generation.id,
                action: "generation",
                creditsConsumed: 1,
              },
            });

            await CreditManager.commitReserved(user.id, 1, `generation:${generation.id}`, "AI content generation");

            await tx.users.update({
              where: { id: user.id },
              data: { generationsUsed: { increment: 1 } },
            });

            return generation;
          });

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ done: true, generation_id: result.id })}\n\n`
            )
          );
        } catch (err) {
          clearTimeout(timer);
          await CreditManager.releaseReserved(user.id, 1, `generate:error`).catch(() => {});
          const safe = sanitizeError(err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: safe.error })}\n\n`)
          );
        } finally {
          clearTimeout(timer);
          try { controller.close(); } catch {}
        }
      },
    });

    return new NextResponse(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const { error, status } = sanitizeError(err);
    if (status === 429) {
      return NextResponse.json({ error }, { status: 429 });
    }
    return NextResponse.json({ error }, { status });
  }
}
