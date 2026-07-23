<div align="center">
  <br />
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://placehold.co/160x160/1e1b4b/6366f1?text=RAI&font=montserrat">
    <img alt="RepurposeAI" src="https://placehold.co/160x160/6366f1/ffffff?text=RAI&font=montserrat" width="160">
  </picture>
  <br />
  <h1 align="center">RepurposeAI</h1>
  <p align="center">AI-powered content repurposing engine. Transform YouTube videos, blog posts, and podcasts into platform-optimized LinkedIn posts, carousels, and X threads — matched to your unique writing voice.</p>

  <p align="center">
    <a href="#features"><strong>Features</strong></a> ·
    <a href="#tech-stack"><strong>Tech Stack</strong></a> ·
    <a href="#architecture"><strong>Architecture</strong></a> ·
    <a href="#getting-started"><strong>Quick Start</strong></a> ·
    <a href="#environment-variables"><strong>Configuration</strong></a> ·
    <a href="#deployment"><strong>Deployment</strong></a>
  </p>

  <p align="center">
    <img src="https://img.shields.io/badge/Next.js_15-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js 15">
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white" alt="Prisma">
    <img src="https://img.shields.io/badge/Neon-00E599?style=for-the-badge&logo=neon&logoColor=black" alt="Neon">
    <img src="https://img.shields.io/badge/Upstash_Redis-00E9A3?style=for-the-badge&logo=redis&logoColor=white" alt="Upstash Redis">
    <img src="https://img.shields.io/badge/Clerk-6C47FF?style=for-the-badge&logo=clerk&logoColor=white" alt="Clerk">
    <img src="https://img.shields.io/badge/Stripe-008CDD?style=for-the-badge&logo=stripe&logoColor=white" alt="Stripe">
    <img src="https://img.shields.io/badge/Cloudinary-3448C5?style=for-the-badge&logo=cloudinary&logoColor=white" alt="Cloudinary">
    <img src="https://img.shields.io/badge/MorphLLM-6C47FF?style=for-the-badge&logo=openai&logoColor=white" alt="MorphLLM">
    <img src="https://img.shields.io/badge/Resend-000000?style=for-the-badge&logo=resend&logoColor=white" alt="Resend">
    <img src="https://img.shields.io/badge/Sentry-362D59?style=for-the-badge&logo=sentry&logoColor=white" alt="Sentry">
    <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel">
  </p>

  <br />
</div>

---

## Features

| Capability | Detail |
|---|---|
| **4 Input Sources** | YouTube URL (transcript + Gemini analysis), blog URL (Readability extraction), podcast URL, raw text paste |
| **3 Output Formats** | LinkedIn post (150–300 words, hook-first), LinkedIn carousel (8–10 slides), X/Twitter thread (5–9 tweets) |
| **Voice Matching** | Create profiles from your real writing samples; AI analyzes tone, structure, and vocabulary — then mirrors it in every generation |
| **Multi-Stage AI Pipeline** | Extract → Analyze → Generate (not a single-prompt wrapper). Each stage is independently optimized and observable |
| **Streaming Generation** | Server-sent events (SSE) stream output token-by-token; no spinner waiting |
| **Chrome Extension** | Manifest V3 extension to repurpose any page while browsing |
| **Stripe Billing** | Free (3 generations), Starter ($19/mo, 30/mo), Pro ($49/mo, unlimited). Checkout + Portal + idempotent webhooks |
| **Scheduled Posting** | Schedule generated content for auto-publish via Vercel Cron (`*/5 * * * *`) |
| **Health Checks** | `GET /api/health` — parallel probes for database, Redis, and environment integrity |
| **Pre-Flight Verification** | `npx tsx scripts/verify-connections.ts` validates all upstream services before `npm run dev` (note: script removed in cleanup; use `npm run build` to verify) |
| **API Reference** | Auto-generated OpenAPI docs at `/api/scalar` via Scalar |

---

## Tech Stack

### Frontend

| Technology | Purpose |
|---|---|
| **Next.js 15** (App Router) | Full-stack framework — React server components, API routes, middleware |
| **Tailwind CSS** + `tailwind-merge` | Utility-first styling with custom brand design tokens |
| **shadcn/ui** (Radix primitives) | Accessible, unstyled component primitives |
| **Framer Motion** 12 | Page transitions, staggered reveals, gesture-driven animations |
| **GSAP** 3 | Scroll-triggered timeline animations on marketing pages |
| **React Three Fiber** + Three.js + Drei | 3D interactive scene on the landing page (cursor-reactive, GLB models) |
| **Lucide React** | Consistent icon set |

### Backend & Infrastructure

| Technology | Purpose |
|---|---|
| **Next.js API Routes** (serverless) | All backend logic — colocated with frontend, deployed as Vercel serverless functions |
| **Neon** (serverless PostgreSQL) | Primary database — pooled connection via Prisma for serverless cold-start avoidance |
| **Prisma** ORM | Type-safe database access, migrations, and schema management |
| **Clerk** | Authentication (email/password + Google OAuth), session management, user profiles |
| **Upstash Redis** (REST) | Rate limiting, session caching, lightweight job coordination |
| **MorphLLM** (OpenAI-compatible) | Primary AI provider — fully abstracted in `lib/ai/provider.ts` for drop-in replacement |
| **Google Gemini** | Secondary AI provider — YouTube transcript analysis, embeddings |
| **Stripe** | Subscription billing — Checkout sessions, Billing Portal, webhook event handling |
| **Cloudinary** | Media upload, transformation, and CDN delivery |
| **Resend** | Transactional email (welcome emails, password resets, receipts) |
| **Sentry** | Error monitoring — instrumented on client, server, and edge runtimes |
| **Vercel Cron Jobs** | `vercel.json`-defined cron for `process-posts` (every 5 minutes) |

---

## Architecture

```
                         ┌─────────────────────────────┐
                         │     Browser / Extension      │
                         └──────────────┬──────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │    Next.js Middleware        │
                          │    (Clerk session)          │
                         └──────────────┬──────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
     ┌────────▼──────┐      ┌──────────▼──────────┐   ┌─────────▼─────────┐
     │  Marketing     │      │  Auth Routes        │   │  Protected App    │
     │  Pages         │      │  (login/signup)     │   │  (dashboard/gen)  │
     └────────┬───────┘      └──────────┬──────────┘   └─────────┬─────────┘
              │                         │                         │
              └──────────────┬──────────┘                         │
                             │                                    │
                    ┌────────▼────────┐                  ┌────────▼────────┐
                    │   /api/health   │                  │  /api/extract   │
                    │  (parallel      │                  │  /api/analyze   │
                    │   probes)       │                  │  /api/generate  │
                    └─────────────────┘                  │  (streaming)    │
                                                          └────────┬────────┘
                                                                   │
              ┌─────────────────────────────────┬───────────────────┼───────────────────┬──────────────────┐
              │                                 │                   │                   │                  │
     ┌────────▼────────┐              ┌─────────▼────────┐ ┌───────▼────────┐ ┌───────▼────────┐ ┌───────▼────────┐
     │   Neon (Prisma) │              │  Upstash Redis   │ │ MorphLLM/Gemini │ │   Stripe       │ │  Cloudinary    │
     │   PostgreSQL    │              │  (cache/ratelimit)│ │ (AI Pipeline)   │ │ (billing)      │ │  (media)       │
     └─────────────────┘              └──────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
                                                                   │
                                                          ┌────────▼────────┐
                                                          │ Vercel Cron     │
                                                          │ */5 * * * *    │
                                                          │ /api/cron/      │
                                                          │ process-posts   │
                                                          └─────────────────┘
```

### AI Pipeline (3-Stage)

```
                          ┌──────────┐    ┌──────────┐    ┌──────────┐
  User Input (URL/Text) ──► Extract   ───► Analyze   ───► Generate  ──► Streamed Output
                          └──────────┘    └──────────┘    └──────────┘
                               │               │               │
                         YouTube/Blog    Gemini/Morph    Format-specific
                         Readability     extracts key    prompt + voice
                         Podcast         hooks, topics   profile matching
```

### Security & Reliability

- **Parallel health checks**: `GET /api/health` probes database connectivity, Redis reachability, and environment variable presence in a single request — failures are reported individually
- **Self-healing cron**: `POST /api/cron/process-posts` is authenticated via a shared `CRON_SECRET` query parameter; the route logs failures, updates `ScheduledPost` status to `FAILED`, and continues processing remaining items
- **Idempotent webhooks**: `POST /api/billing/webhook` uses Stripe's idempotency keys and event-level deduplication to prevent double-processing
- **Rate limiting**: Upstash Redis-backed sliding window rate limiter on all API routes
- **Auth enforcement**: Clerk middleware protects frontend routes; individual API routes verify authentication server-side

---

## Getting Started

### Prerequisites

- Node.js 18+ (runtime)
- A [Neon](https://neon.tech) account (serverless PostgreSQL)
- A [Clerk](https://clerk.com) account (authentication)
- A [MorphLLM](https://morphllm.com) API key (or any OpenAI-compatible provider)
- A [Stripe](https://stripe.com) account (test mode)
- An [Upstash](https://upstash.com) Redis database
- A [Cloudinary](https://cloudinary.com) account
- A [Resend](https://resend.com) API key

### 1. Clone & Install

```bash
git clone https://github.com/your-org/repurpose-ai.git
cd repurpose-ai
npm install
```

### 2. Configure Environment Variables

Copy the example file:

```bash
cp .env.example .env.local
```

Open `.env.local` and populate every variable. Refer to the [Environment Variables](#environment-variables) section below for a complete reference.

> **Security Note**: `.env.local` is git-ignored by default. Never commit real secrets.

### 3. Run Database Migrations

Push the Prisma schema to your Neon database:

```bash
npx prisma generate
npx prisma db push
```

Run `npx prisma db push` to create all tables from the Prisma schema.

### 4. Verify Connections

Before starting the dev server, validate that all upstream services are reachable:

```bash
npx tsx scripts/verify-connections.ts
```

This script calls `GET /api/health` and reports the status of:
- ✅ Database connection (Neon via Prisma)
- ✅ Redis reachability (Upstash)
- ✅ Environment variable presence

A failure in any service will exit with code `1`. Resolve issues before proceeding.

### 5. Start Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 6. Test the Full Flow

1. Sign up at `/signup`
2. Create a voice profile at `/voice` — paste 2–3 examples of your real writing
3. Navigate to `/generate` → paste a blog URL → select **LinkedIn Post** → click **Generate**
4. View saved outputs at `/history`
5. Test billing at `/upgrade` (uses Stripe test mode)
6. Browse the API reference at `/api/scalar`

---

## Environment Variables

All configuration is managed through environment variables. Below is the complete reference grouped by service.

### Neon (Serverless PostgreSQL)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Prisma connection string (pooled, serverless-ready) |

### Clerk (Authentication)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (client-safe) |
| `CLERK_SECRET_KEY` | Clerk secret key (server-only) |

### MorphLLM / AI Provider

| Variable | Description |
|---|---|
| `AI_API_KEY` | API key for the OpenAI-compatible provider |
| `AI_BASE_URL` | Base URL (defaults to `https://api.morphllm.com/v1`) |
| `AI_MODEL` | Model identifier (e.g., `morph-glm52-744b`) |

### Stripe (Billing)

| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (server-only) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (client-safe) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (Stripe dashboard → webhooks) |
| `STRIPE_STARTER_PRICE_ID` | Price ID for the Starter plan ($19/mo) |
| `STRIPE_PRO_PRICE_ID` | Price ID for the Pro plan ($49/mo) |

### Sentry (Monitoring)

| Variable | Description |
|---|---|
| `SENTRY_DSN` | Sentry DSN (server/edge runtime) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (client runtime) |
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project slug |

### Upstash Redis (Caching)

| Variable | Description |
|---|---|
| `REDIS_URL` | REST API URL from Upstash console |
| `REDIS_TOKEN` | REST API token from Upstash console |

### Cron Job Security

| Variable | Description |
|---|---|
| `CRON_SECRET` | Shared secret passed as query parameter to `/api/cron/process-posts` |

### Resend (Email)

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | API key from Resend dashboard |

### Cloudinary (Media)

| Variable | Description |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

### JWT (API Auth)

| Variable | Description |
|---|---|
| `JWT_SECRET` | HMAC secret for signing JWT tokens (generate with `openssl rand -hex 64`) |

### Application

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Application base URL (e.g., `http://localhost:3000` or `https://your-domain.com`) |
| `NEXT_PUBLIC_APP_NAME` | Application display name (`RepurposeAI`) |

### Make.com (Automation)

| Variable | Description |
|---|---|
| `MAKE_API_KEY` | Make.com webhook/API integration key |

---

## Deployment

### Vercel (Recommended)

The application is optimized for the Vercel serverless platform.

```bash
# Install Vercel CLI (optional)
npm i -g vercel

# Deploy
vercel --prod
```

**Steps:**

1. Push the repository to GitHub
2. Import the repository in the [Vercel Dashboard](https://vercel.com/import)
3. Configure **Environment Variables** in Vercel → Project Settings → Environment Variables (add every variable from `.env.local`; note that `DATABASE_URL` should use the pooled connection string for serverless)
4. Deploy — Vercel detects Next.js automatically

### Vercel Cron Configuration

Scheduled posting is configured via `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/process-posts?secret=YOUR_CRON_SECRET",
      "schedule": "0 0 * * *"
    }
  ]
}
```

- **Path**: The cron authenticates via the `secret` query parameter, which must match `CRON_SECRET` in your environment variables
- **Schedule**: Every 5 minutes (`*/5 * * * *`). The handler processes all `ScheduledPost` records with `PENDING` status whose `scheduledAt` timestamp has passed
- **Error handling**: Failed posts are marked `FAILED`; the cron continues processing remaining items without interrupting the cycle

### Stripe Webhook (Production)

After deploying, configure a webhook endpoint in the Stripe Dashboard:

1. Navigate to **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://your-domain.com/api/billing/webhook`
3. Events to listen for:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the signing secret and set it as `STRIPE_WEBHOOK_SECRET` in your Vercel environment variables

---

## Project Structure

```
app/
├── (marketing)/         Landing page, blog, pricing, changelog, legal
├── (auth)/              Login, signup, password reset, callback
├── (app)/               Dashboard, generate, history, voice, settings, upgrade
└── api/                 Health, extract, analyze, generate, voice, billing,
                        cron, schedule, brand-kit, webhooks, upload, usage,
                        embeddings, scalar (API reference)

components/
├── ui/                  shadcn/ui primitives (button, input, card, progress, etc.)
├── layout/              Sidebar, topbar, mobile nav, user menu
├── generate/            Generation wizard (input, format, voice selector, output)
├── voice/               Voice profile CRUD
├── history/             Generation history cards and views
├── billing/             Pricing cards, upgrade modal
├── marketing/           Landing page sections (3D hero, features, how-it-works, etc.)
├── shared/              Logo, loading states, empty states, page header
├── providers/           AuthProvider, UsageProvider, ToastProvider
├── settings/            User settings forms
└── dashboard/           AnalyticsWidget, ScheduleWidget

lib/
├── ai/                  Provider abstraction, prompt engine, Gemini client, embeddings
├── extractors/          YouTube, blog, podcast extractors
├── supabase/            Clerk-backed server client (backward-compat), types
├── stripe/              Config, helpers, webhook parser
├── validations/         Zod schemas + DTOs for every route
├── constants/           Routes, plan definitions, output format configs
├── email/               Resend client
├── webhooks/            Dispatch and trigger utilities

├── cloudinary/          Upload and transform utilities
├── prisma.ts            Singleton PrismaClient
└── redis.ts             Upstash Redis singleton

extension/               Chrome extension (Manifest V3)

prisma/
└── schema.prisma        Database schema (User, VoiceProfile, Generation, ScheduledPost)

supabase/               Clerk-backed server client (backward-compat), types
```

---

## Database Schema (Prisma)

| Model | Key Fields | Description |
|---|---|---|
| **User** | `id` (UUID), `email` (unique), `name` | Core user account, linked to Clerk auth |
| **VoiceProfile** | `id`, `name`, `description`, `userId` (FK → User) | Saved writing style with tone analysis and examples |
| **Generation** | `id`, `title`, `sourceUrl`, `content`, `userId` (FK → User), `voiceProfileId` (FK → VoiceProfile) | All generated content — input, output, metadata |
| **ScheduledPost** | `id`, `platform` (LINKEDIN/TWITTER), `content`, `scheduledAt`, `status` (PENDING/PUBLISHED/FAILED), `userId` (FK → User) | Queued posts processed by Vercel Cron |

All tables enforce foreign key constraints with cascade deletes where appropriate.

---

## Chrome Extension

The extension lives in `extension/` and uses Manifest V3.

To build and test locally:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` directory
4. Navigate to any blog article → click the extension icon → **Repurpose This Page**

The extension injects a content script that extracts page content and sends it to the RepurposeAI API. Authentication is handled via a JWT token stored in extension storage.

---

## AI Provider Abstraction

The AI layer is fully abstracted behind `lib/ai/provider.ts`. To swap providers:

1. Install your provider's SDK (e.g., `npm install openai`)
2. Replace `lib/ai/provider.ts` with an OpenAI-compatible client (the interface is already a drop-in for any OpenAI-compatible API)
3. Update `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` in your environment variables
4. No other application code changes are required

The provider is consumed by `lib/ai/analyze.ts`, `lib/ai/generate.ts`, and `lib/ai/embeddings.ts`.

---

## License

[MIT](LICENSE)

---

<p align="center">
  Built with Next.js 15, TypeScript, and ❤️
  <br />
  <a href="https://vercel.com">Deployed on Vercel</a>
</p>
