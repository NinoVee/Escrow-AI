"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { buttonClass } from "./ui";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={className ?? buttonClass("secondary", "sm")}
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
