import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/");
  const demo = process.env.NODE_ENV !== "production";
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16 sm:items-center">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold tracking-tight text-brand-800">EscrowFlow</div>
          <p className="mt-1 text-sm text-slate-500">Workflow support for escrow professionals</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <SignInForm />
        </div>
        {demo && (
          <p className="mt-4 text-center text-xs text-slate-500">
            Local demo: see README for fictional demo accounts and the <code>npm run demo:totp</code> helper.
          </p>
        )}
        <p className="mt-6 text-center text-xs text-slate-400">
          EscrowFlow is software used by escrow staff. It is not an escrow company, title insurer or law firm, and it does not hold funds.
        </p>
      </div>
    </main>
  );
}
