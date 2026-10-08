"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { buttonClass, inputClass } from "@/components/ui";

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  async function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const { data, error } = await authClient.signIn.email({
      email: String(fd.get("email")),
      password: String(fd.get("password")),
    });
    setPending(false);
    if (error) {
      setError(error.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Email or password is incorrect.");
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setStep("totp");
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    const res = useBackup ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (res.error) {
      setError(res.error.status === 429 ? "Too many attempts. Try again later." : "That code was not accepted.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  if (step === "totp") {
    return (
      <form onSubmit={onCode} className="space-y-4" aria-label="Two-factor verification">
        <p className="text-sm text-slate-600">{useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}</p>
        <div>
          <label htmlFor="code" className="block text-sm font-medium text-slate-700">
            {useBackup ? "Backup code" : "Authenticator code"}
          </label>
          <input id="code" name="code" required autoFocus autoComplete="one-time-code" inputMode={useBackup ? "text" : "numeric"} className={`${inputClass} mt-1 tabular`} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full`}>
          {pending ? "Verifying…" : "Verify and sign in"}
        </button>
        <button type="button" className="text-sm text-brand-700 underline" onClick={() => setUseBackup((v) => !v)}>
          {useBackup ? "Use authenticator code instead" : "Use a backup code"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onPassword} className="space-y-4" aria-label="Sign in">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input id="email" name="email" type="email" required autoComplete="username" className={`${inputClass} mt-1`} />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full`}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
