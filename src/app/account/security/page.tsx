import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { Alert } from "@/components/ui";
import { MfaSetup } from "./mfa-setup";
import { SignOutButton } from "@/components/sign-out-button";

export const metadata: Metadata = { title: "Account security" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const { required } = await searchParams;
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Account security</h1>
        <SignOutButton />
      </div>
      {required && !user.twoFactorEnabled && (
        <div className="mb-4">
          <Alert tone="warning" title="Two-factor authentication required">
            Your company requires staff to use an authenticator app before accessing escrow files.
          </Alert>
        </div>
      )}
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="mb-4 text-sm text-slate-600">Signed in as {user.email}</p>
        <MfaSetup enabled={user.twoFactorEnabled} />
      </div>
    </main>
  );
}
