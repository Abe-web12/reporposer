import { auth, clerkClient } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { humanizeAuthError, AUTH_ERROR_MESSAGES } from "./errors";

export interface SyncResult {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  organizationId: string;
  isNewUser: boolean;
}

function extractEmail(clerkUser: Awaited<ReturnType<Awaited<ReturnType<typeof clerkClient>>["users"]["getUser"]>>): string {
  return (
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses?.[0]?.emailAddress ??
    ""
  );
}

function extractName(clerkUser: Awaited<ReturnType<Awaited<ReturnType<typeof clerkClient>>["users"]["getUser"]>>): string {
  const firstName = clerkUser.firstName ?? "";
  const lastName = clerkUser.lastName ?? "";
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || clerkUser.username || extractEmail(clerkUser).split("@")[0] || "User";
}

export async function ensureUserSync(userId: string): Promise<SyncResult> {
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(userId);
  const email = extractEmail(clerkUser);
  const name = extractName(clerkUser);

  let isNewUser = false;

  const result = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.users.findUnique({ where: { id: userId } });

    if (!existingUser) {
      isNewUser = true;
    }

    const user = await tx.users.upsert({
      where: { id: userId },
      update: {
        email,
        name,
        fullName: name,
        avatarUrl: clerkUser.imageUrl || null,
      },
      create: {
        id: userId,
        email,
        passwordHash: "",
        name,
        fullName: name,
        avatarUrl: clerkUser.imageUrl || null,
        plan: "free",
        generationsLimit: 3,
        generationsUsed: 0,
        onboardingCompleted: false,
      },
    });

    let organizationId: string;

    const existingMembership = await tx.organizationMembers.findFirst({
      where: { userId },
      include: { organization: true },
    });

    if (existingMembership) {
      organizationId = existingMembership.organizationId;
    } else {
      const org = await tx.organizations.create({
        data: {
          name: `${name}'s Organization`,
          slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID()}`,
          plan: "free",
          maxSeats: 5,
        },
      });

      await tx.organizationMembers.create({
        data: {
          organizationId: org.id,
          userId,
          role: "OWNER",
        },
      });

      await tx.organizationAuditLogs.create({
        data: {
          organizationId: org.id,
          actorId: userId,
          action: "ORGANIZATION_CREATED",
          entityType: "organization",
          entityId: org.id,
          details: { name: org.name },
        },
      });

      organizationId = org.id;
    }

    await tx.creditBalances.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        balance: 10,
        reserved: 0,
      },
    });

    const existingUsage = await tx.usageLog.findFirst({
      where: { userId },
    });

    if (!existingUsage) {
      await tx.usageLog.create({
        data: {
          userId,
          action: "ACCOUNT_CREATED",
        },
      });
    }

    return { user, organizationId };
  });

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
    },
    organizationId: result.organizationId,
    isNewUser,
  };
}

export async function getServerUser() {
  const session = await auth();
  const userId = session?.userId;
  if (!userId) return null;

  try {
    return await ensureUserSync(userId);
  } catch {
    return null;
  }
}

export async function getServerUserId(): Promise<string | null> {
  const session = await auth();
  return session?.userId ?? null;
}

export { humanizeAuthError, AUTH_ERROR_MESSAGES } from "./errors";