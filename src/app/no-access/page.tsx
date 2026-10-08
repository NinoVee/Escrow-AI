import { SignOutButton } from "@/components/sign-out-button";

export default function NoAccess() {
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">No active company access</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your account is not an active member of any escrow company, or your access was disabled. Contact your company administrator.
      </p>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </main>
  );
}
