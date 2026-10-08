"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";
import { buttonClass, inputClass } from "@/components/ui";

export function MfaSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<"start" | "verify" | "done">(enabled ? "done" : "start");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const password = String(new FormData(e.currentTarget).get("password"));
    const { data, error } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (error || !data || !("totpURI" in data)) {
      setError("Password incorrect, or MFA could not be started.");
      return;
    }
    setBackupCodes(data.backupCodes);
    setSecret(new URL(data.totpURI).searchParams.get("secret"));
    setQr(await QRCode.toString(data.totpURI, { type: "svg", margin: 1, width: 180 }));
    setStage("verify");
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) {
      setError("That code was not accepted. Check your device clock and try again.");
      return;
    }
    setStage("done");
    router.refresh();
  }

  if (stage === "done") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-emerald-800">Two-factor authentication is enabled on this account.</p>
        {backupCodes.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium">Save these backup codes now. They will not be shown again.</p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <Link href="/" className={buttonClass("primary")}>
          Continue
        </Link>
      </div>
    );
  }

  if (stage === "verify") {
    return (
      <form onSubmit={verify} className="space-y-4">
        <p className="text-sm text-slate-600">Scan this code with an authenticator app, then enter the 6-digit code to finish.</p>
        {qr && <div className="w-[180px]" aria-label="TOTP QR code" role="img" dangerouslySetInnerHTML={{ __html: qr }} />}
        {secret && (
          <p className="text-xs text-slate-500">
            Manual entry key: <code className="break-all font-mono">{secret}</code>
          </p>
        )}
        <div>
          <label htmlFor="code" className="block text-sm font-medium">
            Authenticator code
          </label>
          <input id="code" name="code" required inputMode="numeric" autoComplete="one-time-code" className={`${inputClass} mt-1 w-40 tabular`} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button disabled={pending} className={buttonClass("primary")}>
          {pending ? "Verifying…" : "Verify and enable"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={start} className="space-y-4">
      <p className="text-sm text-slate-600">Confirm your password to set up an authenticator app.</p>
      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button disabled={pending} className={buttonClass("primary")}>
        {pending ? "Starting…" : "Set up authenticator"}
      </button>
    </form>
  );
}
