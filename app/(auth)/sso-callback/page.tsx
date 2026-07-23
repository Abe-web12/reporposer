"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

export default function SsoCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const [status, setStatus] = useState<"processing" | "redirecting" | "error">("processing");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!isLoaded) return;

    if (isSignedIn) {
      setStatus("redirecting");
      const next = searchParams.get("next") || "/dashboard";
      const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      setTimeout(() => { window.location.href = safeNext; }, 500);
      return;
    }

    const error = searchParams.get("error");
    if (error) {
      setStatus("error");
      setErrorMsg("SSO authentication failed. Please try signing in again.");
      return;
    }

    setStatus("error");
    setErrorMsg("SSO authentication did not complete. Please try again.");
  }, [isLoaded, isSignedIn, searchParams]);

  return (
    <div className="flex min-h-[300px] items-center justify-center">
      <div className="text-center">
        {status === "processing" && (
          <div className="space-y-4">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-indigo-400" />
            <p className="text-sm text-slate-300">Completing authentication...</p>
          </div>
        )}
        {status === "redirecting" && (
          <div className="space-y-4">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
            <p className="text-sm text-slate-300">Authentication successful. Redirecting...</p>
          </div>
        )}
        {status === "error" && (
          <div className="space-y-4">
            <p className="text-sm text-red-400">{errorMsg}</p>
            <button
              onClick={() => router.push("/login")}
              className="text-sm font-medium text-indigo-300 hover:text-indigo-200 underline"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}