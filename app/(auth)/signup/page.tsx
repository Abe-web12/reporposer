"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail, UserRound } from "lucide-react"
import { useAuth, useSignUp } from "@clerk/nextjs"
import { signupSchema } from "@/lib/validations/auth"
import { humanizeAuthError } from "@/lib/auth/errors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { showError, showSuccess } from "@/components/ui/toast"

function extractClerkError(err: unknown): string {
  if (!err || typeof err !== "object") return "Something went wrong. Please try again."
  const e = err as { errors?: Array<{ longMessage?: string; message?: string; code?: string }>; message?: string; longMessage?: string }
  const raw = e.errors?.[0]?.longMessage || e.errors?.[0]?.message || e.longMessage || e.message || ""
  const code = e.errors?.[0]?.code || ""

  if (!raw && !code) return "Something went wrong. Please try again."

  return humanizeAuthError(raw || code)
}

type Step = "signup" | "verify"

export default function SignupPage() {
  const { isLoaded, isSignedIn } = useAuth()
  const { signUp } = useSignUp()
  const [form, setForm] = useState({ full_name: "", email: "", password: "", confirm_password: "" })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [clerkError, setClerkError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [step, setStep] = useState<Step>("signup")
  const [code, setCode] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      window.location.href = "/dashboard"
    }
  }, [isLoaded, isSignedIn])

  useEffect(() => {
    if (!signUp) return
    if (signUp.status !== "complete") return
    window.location.href = "/dashboard"
  }, [signUp])

  if (!isLoaded) return null
  if (isSignedIn) return null

  function update(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => ({ ...prev, [field]: "" }))
  }

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErrors({})
    setClerkError("")

    const result = signupSchema.safeParse(form)
    if (!result.success) {
      const fe = result.error.flatten().fieldErrors
      const flat: Record<string, string> = {}
      for (const [key, msgs] of Object.entries(fe)) { if (msgs?.[0]) flat[key] = msgs[0] }
      setErrors(flat)
      return
    }

    setLoading(true)
    try {
      const { error } = await signUp.create({
        emailAddress: result.data.email,
        password: result.data.password,
      })

      if (error) {
        const msg = extractClerkError(error)
        setClerkError(msg)
        showError(msg)
        return
      }

      if (signUp.status === "complete") {
        const { error: finalizeError } = await signUp.finalize()
        if (finalizeError) {
          const msg = extractClerkError(finalizeError)
          setClerkError(msg)
          showError(msg)
          return
        }
        window.location.href = "/dashboard"
        return
      }

      if (signUp.status === "missing_requirements") {
        if (signUp.verifications?.emailAddress?.status === "unverified") {
          const { error: sendError } = await signUp.verifications.sendEmailCode()
          if (sendError) {
            const msg = extractClerkError(sendError)
            setClerkError(msg)
            showError(msg)
            return
          }
          showSuccess("Verification code sent! Check your email inbox.")
          setStep("verify")
          return
        }

        if (signUp.missingFields?.length) {
          const msg = `Please complete the following: ${signUp.missingFields.join(", ")}.`
          setClerkError(msg)
          showError(msg)
          return
        }
      }

      const msg = "Sign up failed. Please try again."
      setClerkError(msg)
      showError(msg)
    } catch (err: unknown) {
      const msg = extractClerkError(err)
      setClerkError(msg)
      showError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setClerkError("")

    if (!code.trim() || code.trim().length < 6) {
      setClerkError("Please enter the complete 6-digit verification code.")
      return
    }

    setVerifying(true)
    try {
      const { error } = await signUp.verifications.verifyEmailCode({ code: code.trim() })

      if (error) {
        const msg = extractClerkError(error)
        if (msg.includes("expired")) {
          setClerkError("This verification code has expired. Please request a new one.")
        } else {
          setClerkError(msg)
        }
        showError(msg)
        return
      }

      if (signUp.status === "complete") {
        const { error: finalizeError } = await signUp.finalize()
        if (finalizeError) {
          const msg = extractClerkError(finalizeError)
          setClerkError(msg)
          showError(msg)
          return
        }
        showSuccess("Email verified! Redirecting...")
        window.location.href = "/dashboard"
        return
      }

      if (signUp.status === "missing_requirements") {
        if (signUp.missingFields?.length) {
          const msg = `Please complete the following: ${signUp.missingFields.join(", ")}.`
          setClerkError(msg)
          showError(msg)
          return
        }
      }

      const msg = "Verification failed. Please try again."
      setClerkError(msg)
      showError(msg)
    } catch (err: unknown) {
      const msg = extractClerkError(err)
      setClerkError(msg)
      showError(msg)
    } finally {
      setVerifying(false)
    }
  }

  async function handleResendCode() {
    setClerkError("")
    setResending(true)
    try {
      const { error } = await signUp.verifications.sendEmailCode()
      if (error) {
        const msg = extractClerkError(error)
        setClerkError(msg)
        showError(msg)
        return
      }
      showSuccess("New code sent! Check your email.")
      setCode("")
    } catch (err: unknown) {
      const msg = extractClerkError(err)
      setClerkError(msg)
      showError(msg)
    } finally {
      setResending(false)
    }
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true)
    setClerkError("")
    try {
      const { error } = await signUp.sso({
        strategy: "oauth_google",
        redirectUrl: `${window.location.origin}/callback`,
        redirectCallbackUrl: `${window.location.origin}/dashboard`,
      } as const)
      if (error) {
        const msg = extractClerkError(error)
        setClerkError(msg)
        showError(msg)
        setGoogleLoading(false)
      }
    } catch (err: unknown) {
      const msg = extractClerkError(err)
      setClerkError(msg)
      showError(msg)
      setGoogleLoading(false)
    }
  }

  if (step === "verify") {
    return (
      <div>
        <button
          type="button"
          onClick={() => { setStep("signup"); setClerkError(""); setCode("") }}
          className="mb-6 flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign up
        </button>

        <p className="text-sm font-semibold uppercase tracking-[0.1em] text-indigo-300">Verify your email</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">Check your inbox</h2>
        <p className="mt-3 text-base leading-7 text-slate-300">
          We sent a 6-digit verification code to <span className="font-medium text-white">{form.email}</span>. Enter it below to activate your account.
        </p>

        {clerkError && (
          <div
            className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 [&_a]:text-indigo-300 [&_a:hover]:text-indigo-200 [&_a]:font-semibold [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: clerkError }}
          />
        )}

        <form className="mt-8 space-y-5" onSubmit={handleVerifyCode} noValidate>
          <div>
            <label htmlFor="code" className="mb-2 block text-sm font-medium text-slate-200">Verification code</label>
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="e.g. 123456"
              value={code}
              onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setCode(v); setClerkError("") }}
              maxLength={6}
            />
          </div>
          <Button type="submit" size="lg" loading={verifying} className="w-full">
            {verifying ? "Verifying..." : "Verify email"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Did not receive the code?{" "}
          <button
            type="button"
            disabled={resending}
            onClick={handleResendCode}
            className="font-semibold text-indigo-300 hover:text-indigo-200 disabled:opacity-50"
          >
            {resending ? "Resending..." : "Resend code"}
          </button>
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-[0.1em] text-indigo-300">Start free</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">Create your account</h2>
      <p className="mt-3 text-base leading-7 text-slate-300">3 free generations. No credit card required.</p>

      {clerkError && (
        <div
          className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 [&_a]:text-indigo-300 [&_a:hover]:text-indigo-200 [&_a]:font-semibold [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: clerkError }}
        />
      )}

      <form className="mt-8 space-y-5" onSubmit={handleSignup} noValidate>
        <Field label="Full name" htmlFor="full_name">
          <Input id="full_name" autoComplete="name" placeholder="Your name" value={form.full_name} onChange={(e) => update("full_name", e.target.value)} error={errors.full_name} icon={<UserRound className="h-4 w-4" />} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" value={form.email} onChange={(e) => update("email", e.target.value)} error={errors.email} icon={<Mail className="h-4 w-4" />} />
        </Field>
        <Field label="Password" htmlFor="password">
          <div className="relative">
            <Input id="password" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="At least 6 characters" value={form.password} onChange={(e) => update("password", e.target.value)} error={errors.password} icon={<LockKeyhole className="h-4 w-4" />} className="pr-12" />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200" aria-label={showPassword ? "Hide password" : "Show password"}>
              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
        </Field>
        <Field label="Confirm password" htmlFor="confirm_password">
          <Input id="confirm_password" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Repeat password" value={form.confirm_password} onChange={(e) => update("confirm_password", e.target.value)} error={errors.confirm_password} icon={<LockKeyhole className="h-4 w-4" />} />
        </Field>

        <p className="text-xs leading-5 text-slate-400">
          By creating an account you agree to our <Link href="/legal/terms" className="underline hover:text-white">Terms</Link> and <Link href="/legal/privacy" className="underline hover:text-white">Privacy Policy</Link>.
        </p>

        <Button type="submit" size="lg" loading={loading} className="w-full">Create free account</Button>
      </form>

      <div className="my-7 flex items-center gap-4">
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-xs font-medium uppercase tracking-widest text-slate-400">or</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <Button
        type="button"
        variant="outline"
        size="lg"
        loading={googleLoading}
        onClick={handleGoogleLogin}
        className="w-full border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62Z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"/></svg>
        Continue with Google
      </Button>

      <p className="mt-8 text-center text-sm text-slate-400">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-indigo-300 hover:text-indigo-200">Sign in</Link>
      </p>
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <div><label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-slate-200">{label}</label>{children}</div>
}