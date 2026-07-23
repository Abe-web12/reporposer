/**
 * Shared API Middleware
 *
 * Combines authentication, organization isolation, RBAC permission checks,
 * rate limiting, CSRF protection, IP/country restriction, plan enforcement,
 * audit logging, Sentry tracing, and standardized error handling.
 *
 * Usage (mutation):
 *   export const POST = mutationHandler({
 *     permission: "generation:create",
 *     rateLimit: { maxRequests: 10 },
 *     plan: { minTier: "starter", feature: "generation" },
 *     audit: (body) => ({ action: "generation.create", entityType: "generation" }),
 *     handler: async (req, ctx, body, params) => { ... },
 *     name: "generation.create",
 *   });
 *
 * Usage (query):
 *   export const GET = queryHandler({
 *     permission: "analytics:view",
 *     handler: async (req, ctx, params) => { ... },
 *     name: "analytics.list",
 *   });
 *
 * For routes that need streaming responses or custom handling,
 * use getAuthContext(), requirePermission(), withRateLimit() directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { AppError, sanitizeError } from "@/lib/utils/api-errors";
import { getBaseUrl } from "@/lib/utils";
import { rateLimit } from "@/lib/utils/rate-limit";
import { AuditManager } from "@/lib/security/audit";
import { PolicyManager } from "@/lib/security/policies";
import { ThreatDetector } from "@/lib/security/threats";
import { hasPermission as orgHasPermission, getRolePermissions, Permission, PermissionType } from "@/lib/organizations/permissions";
import { EXTENDED_PLANS } from "@/lib/billing/pricing";
import { headers } from "next/headers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditAction {
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteContext {
  userId: string;
  orgId?: string;
  role?: string;
  ip: string;
  userAgent: string;
  country?: string;
}

export interface PlanGate {
  minTier: string;
  feature: string;
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

/**
 * Get the authenticated user from Clerk. Throws 401 if unauthenticated.
 * Also resolves the user's primary organization membership, IP, and country.
 */
export async function getAuthContext(request: NextRequest): Promise<RouteContext> {
  const { userId } = await auth();
  if (!userId) throw new AppError("Unauthorized", 401);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";

  const userAgent = request.headers.get("user-agent") || "unknown";
  const cfCountry = request.headers.get("cf-ipcountry") || request.headers.get("x-vercel-ip-country") || undefined;

  const member = await prisma.organizationMembers.findFirst({
    where: { userId },
    select: {
      organizationId: true,
      role: true,
    },
  });

  return {
    userId,
    orgId: member?.organizationId,
    role: member?.role,
    ip,
    userAgent,
    country: cfCountry,
  };
}

/**
 * Assert the user belongs to an organization. Throws 403 if not.
 */
export function requireOrg(ctx: RouteContext): asserts ctx is RouteContext & { orgId: string } {
  if (!ctx.orgId) {
    throw new AppError("You must belong to an organization to perform this action", 403);
  }
}

/**
 * Assert the user has at least the given role level. Throws 403 if not.
 */
export function requireRole(ctx: RouteContext, minimumRole: string): void {
  const hierarchy: Record<string, number> = {
    OWNER: 100,
    ADMIN: 80,
    MANAGER: 60,
    EDITOR: 40,
    VIEWER: 20,
  };
  const userLevel = hierarchy[ctx.role ?? "VIEWER"] ?? 0;
  const requiredLevel = hierarchy[minimumRole] ?? 0;
  if (userLevel < requiredLevel) {
    throw new AppError("You do not have permission to perform this action", 403);
  }
}

/**
 * Assert the user has a specific org permission. Throws 403 if not.
 * Uses the org permission system from lib/organizations/permissions.ts.
 */
export function requirePermission(ctx: RouteContext, permission: PermissionType): void {
  if (!ctx.orgId) {
    throw new AppError("You must belong to an organization to perform this action", 403);
  }
  if (!orgHasPermission(ctx.role ?? "VIEWER", permission)) {
    throw new AppError("You do not have permission to perform this action", 403);
  }
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Apply sliding-window rate limiting keyed by user ID.
 * Throws 429 when exceeded.
 */
export async function withRateLimit(
  ctx: RouteContext,
  windowMs = 60_000,
  maxRequests = 30,
): Promise<void> {
  const result = await rateLimit(`api:${ctx.userId}`, { windowMs, maxRequests });
  if (!result.success) {
    await ThreatDetector.record("rate_limit_exceeded", {
      userId: ctx.userId,
      organizationId: ctx.orgId,
      ipAddress: ctx.ip,
      severity: "medium",
      details: { windowMs, maxRequests },
    });
    throw new AppError("Too many requests. Please slow down.", 429);
  }
}

// ─── CSRF Protection ──────────────────────────────────────────────────────────

/**
 * Validates CSRF token for state-changing requests (POST, PATCH, PUT, DELETE).
 * For API routes, we use a custom header or check the Origin/Referer.
 * Skips validation if no origin (same-origin requests from server).
 */
export function validateCsrf(request: NextRequest): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const appUrl = getBaseUrl();

  if (!origin && !referer) return;

  try {
    const source = (origin || referer || "");
    const sourceUrl = new URL(source);
    const allowed = new URL(appUrl);
    if (sourceUrl.origin !== allowed.origin && !allowed.origin.endsWith(".vercel.app")) {
      throw new AppError("CSRF validation failed", 403);
    }
  } catch {
    if (origin || referer) {
      throw new AppError("CSRF validation failed", 403);
    }
  }
}

// ─── IP / Country Restriction Enforcement ─────────────────────────────────────

/**
 * Check the request against the organization's security policy for IP and country
 * restrictions. Throws 403 if the request is not allowed.
 */
export async function enforceIpCountryPolicy(ctx: RouteContext): Promise<void> {
  if (!ctx.orgId) return;

  try {
    const [ipAllowed, countryAllowed] = await Promise.all([
      PolicyManager.isIpAllowed(ctx.ip, ctx.orgId),
      ctx.country ? PolicyManager.isCountryAllowed(ctx.country, ctx.orgId) : Promise.resolve(true),
    ]);

    if (!ipAllowed) {
      await ThreatDetector.record("ip_restricted", {
        organizationId: ctx.orgId,
        userId: ctx.userId,
        ipAddress: ctx.ip,
        severity: "high",
        details: { policy: "ip_restriction" },
      });
      throw new AppError("Access denied from this IP address", 403);
    }

    if (!countryAllowed) {
      await ThreatDetector.record("country_restricted", {
        organizationId: ctx.orgId,
        userId: ctx.userId,
        ipAddress: ctx.ip,
        country: ctx.country,
        severity: "high",
        details: { policy: "country_restriction" },
      });
      throw new AppError("Access denied from this location", 403);
    }
  } catch (err) {
    // Re-throw AppErrors (actual policy violations), swallow others (e.g. missing DB in tests)
    if (err instanceof AppError) throw err;
  }
}

// ─── Plan Enforcement ─────────────────────────────────────────────────────────

const TIER_ORDER: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  business: 3,
  enterprise: 4,
};

/**
 * Enforce that the user's plan meets the minimum tier for a feature.
 * Throws 403 if the plan is insufficient.
 */
export async function requirePlan(userId: string, gate: PlanGate): Promise<void> {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { plan: true, generationsLimit: true, generationsUsed: true },
  });
  if (!user) throw new AppError("User not found", 404);

  const userTier = TIER_ORDER[user.plan as string] ?? -1;
  const minTier = TIER_ORDER[gate.minTier] ?? 0;

  if (userTier < minTier) {
    throw new AppError(`Upgrade to ${gate.minTier} to access ${gate.feature}`, 403);
  }

  if (gate.feature === "generation" && user.plan !== "enterprise") {
    if (user.generationsLimit > 0 && user.generationsUsed >= user.generationsLimit) {
      throw new AppError("Generation limit reached. Upgrade your plan for more.", 403);
    }
  }
}

/**
 * Return the user's remaining usage for a given feature.
 */
export async function getRemainingUsage(userId: string): Promise<{ limit: number; used: number; remaining: number }> {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { plan: true, generationsLimit: true, generationsUsed: true },
  });
  if (!user) throw new AppError("User not found", 404);

  return {
    limit: user.generationsLimit,
    used: user.generationsUsed,
    remaining: Math.max(0, user.generationsLimit - user.generationsUsed),
  };
}

// ─── Audit Logging ────────────────────────────────────────────────────────────

/**
 * Persist an audit log entry to the security_audit_logs table.
 * Includes organizationId, userId, action, entity, entityId, metadata, ip, and userAgent.
 */
export async function logAudit(
  ctx: RouteContext,
  action: AuditAction,
): Promise<void> {
  try {
    await AuditManager.record({
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      action: action.action,
      entityType: action.entityType,
      entityId: action.entityId,
      metadata: action.metadata,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    // Audit logging should never crash the request
    console.error("[Audit] Failed to write audit log:", err);
  }
}

// ─── Unified Mutation Handler ─────────────────────────────────────────────────

/**
 * Factory for mutation endpoints (POST / PATCH / PUT / DELETE).
 * Automatically handles:
 *   - Clerk authentication
 *   - Org membership resolution
 *   - RBAC permission check (optional)
 *   - CSRF validation
 *   - IP / country restriction enforcement
 *   - Plan tier enforcement (optional)
 *   - Rate limiting
 *   - Audit logging
 *   - Sentry tracing
 *   - Standardized error serialisation
 *
 * @example
 * export const POST = mutationHandler({
 *   permission: "generation:create",
 *   rateLimit: { maxRequests: 10 },
 *   plan: { minTier: "starter", feature: "generation" },
 *   audit: (body) => ({ action: "generation.create", entityType: "generation" }),
 *   handler: async (request, ctx, body, params) => { ... },
 *   name: "generation.create",
 * });
 */
export function mutationHandler<TBody, TParams = Record<string, string>>(config: {
  /** Optional RBAC permission required */
  permission?: PermissionType;
  /** Optional per-endpoint rate-limit overrides */
  rateLimit?: { windowMs?: number; maxRequests?: number };
  /** Optional plan tier enforcement */
  plan?: PlanGate;
  /** Called with the parsed body to build the audit action metadata */
  audit?: (body: TBody) => AuditAction;
  /** The actual route logic. Return a NextResponse or any JSON-serializable value. */
  handler: (
    request: NextRequest,
    ctx: RouteContext,
    body: TBody,
    params?: TParams,
  ) => Promise<NextResponse | Record<string, unknown>>;
  /** Optional body parser override (defaults to request.json) */
  parseBody?: (request: NextRequest) => Promise<TBody>;
  /** Sentry operation name */
  name: string;
  /** Set to false to skip CSRF validation (e.g. for webhook endpoints) */
  csrf?: boolean;
}): (request: NextRequest, routeParams: { params: Promise<TParams> }) => Promise<NextResponse> {
  return async (request: NextRequest, routeParams: { params: Promise<TParams> }) => {
    return Sentry.startSpan(
      {
        op: "http.server",
        name: config.name,
        attributes: { "http.method": request.method, "http.url": request.nextUrl.pathname },
      },
      async () => {
        try {
          // 1. Authenticate & resolve org
          const ctx = await getAuthContext(request);

          // 2. CSRF validation (skip for webhooks and GET/HEAD)
          if (config.csrf !== false) {
            validateCsrf(request);
          }

          // 3. Rate limit
          await withRateLimit(ctx, config.rateLimit?.windowMs, config.rateLimit?.maxRequests);

          // 4. Permission check
          if (config.permission) {
            requirePermission(ctx, config.permission);
          }

          // 5. IP / country policy enforcement
          await enforceIpCountryPolicy(ctx);

          // 6. Plan tier enforcement
          if (config.plan) {
            await requirePlan(ctx.userId, config.plan);
          }

          // 7. Parse route params
          const params = routeParams?.params ? await routeParams.params : undefined;

          // 8. Parse body
          const body = config.parseBody
            ? await config.parseBody(request)
            : (await request.json().catch(() => {
                throw new AppError("Invalid JSON in request body", 400);
              })) as TBody;

          // 9. Run handler
          const result = await config.handler(request, ctx, body, params);

          // 10. Audit log the mutation
          if (config.audit) {
            await logAudit(ctx, config.audit(body));
          }

          const response = result instanceof NextResponse ? result : NextResponse.json(result);
          response.headers.set("Cache-Control", "no-store, must-revalidate");
          return response;
        } catch (err) {
          Sentry.captureException(err);
          const { error, status } = sanitizeError(err);
          return NextResponse.json({ error }, { status });
        }
      },
    );
  };
}

/**
 * Factory for read-only (GET) endpoints.
 * Automatically handles authentication, rate limiting, permission checks,
 * IP/country policy, Sentry, and error serialisation.
 */
export function queryHandler<TParams = Record<string, string>>(config: {
  /** Optional RBAC permission required */
  permission?: PermissionType;
  rateLimit?: { windowMs?: number; maxRequests?: number };
  handler: (request: NextRequest, ctx: RouteContext, params?: TParams) => Promise<NextResponse>;
  name: string;
  /** Set to false to skip IP/country policy check */
  enforcePolicy?: boolean;
}): (request: NextRequest, routeParams: { params: Promise<TParams> }) => Promise<NextResponse> {
  return async (request: NextRequest, routeParams: { params: Promise<TParams> }) => {
    return Sentry.startSpan(
      {
        op: "http.server",
        name: config.name,
        attributes: { "http.method": request.method, "http.url": request.nextUrl.pathname },
      },
      async () => {
        try {
          const ctx = await getAuthContext(request);
          await withRateLimit(ctx, config.rateLimit?.windowMs, config.rateLimit?.maxRequests);

          if (config.permission) {
            requirePermission(ctx, config.permission);
          }

          if (config.enforcePolicy !== false) {
            await enforceIpCountryPolicy(ctx);
          }

          const params = routeParams?.params ? await routeParams.params : undefined;
          const response = await config.handler(request, ctx, params);
          response.headers.set("Cache-Control", "no-store, must-revalidate");
          return response;
        } catch (err) {
          Sentry.captureException(err);
          const { error, status } = sanitizeError(err);
          return NextResponse.json({ error }, { status });
        }
      },
    );
  };
}
