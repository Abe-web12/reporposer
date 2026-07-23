import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { headers } from "next/headers";
import type { WebhookEvent } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { ensureUserSync } from "@/lib/auth/sync";

export const runtime = "nodejs";

async function handleUserEvent(event: WebhookEvent) {
  const { id } = event.data;
  if (!id) return;

  switch (event.type) {
    case "user.created":
    case "user.updated": {
      await ensureUserSync(id);
      break;
    }

    case "user.deleted": {
      await prisma.users.delete({ where: { id } }).catch(() => {});
      break;
    }
  }
}

async function handleOrganizationEvent(event: WebhookEvent) {
  const { id } = event.data;
  if (!id) return;

  switch (event.type) {
    case "organization.created": {
      const data = event.data as {
        id: string;
        name?: string;
        slug?: string;
        created_by?: string;
      };
      const existingOrg = await prisma.organizations.findUnique({
        where: { id },
      });
      if (!existingOrg) {
        await prisma.organizations.create({
          data: {
            id,
            name: data.name ?? "Organization",
            slug: data.slug ?? `org-${id.slice(0, 8)}`,
            plan: "free",
            maxSeats: 5,
          },
        });
      }
      break;
    }

    case "organization.updated": {
      const data = event.data as {
        id: string;
        name?: string;
        slug?: string;
      };
      await prisma.organizations.update({
        where: { id },
        data: {
          name: data.name,
          slug: data.slug,
        },
      });
      break;
    }

    case "organization.deleted": {
      await prisma.organizations.delete({ where: { id } }).catch(() => {});
      break;
    }
  }
}

export async function POST(request: NextRequest) {
  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: "Missing svix headers" },
      { status: 400 }
    );
  }

  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  let event: WebhookEvent;
  try {
    const wh = new Webhook(secret);
    const payload = await request.clone().text();
    event = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 }
    );
  }

  try {
    const userEventTypes = new Set([
      "user.created",
      "user.updated",
      "user.deleted",
    ]);
    const orgEventTypes = new Set([
      "organization.created",
      "organization.updated",
      "organization.deleted",
    ]);

    if (userEventTypes.has(event.type)) {
      await handleUserEvent(event);
    } else if (orgEventTypes.has(event.type)) {
      await handleOrganizationEvent(event);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Clerk webhook sync error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}