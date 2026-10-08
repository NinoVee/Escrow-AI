"use client";

import { useActionState, useTransition } from "react";
import Link from "next/link";
import { acceptInviteAction } from "./actions";
import { INITIAL_STATE } from "@/lib/action-types";
import { buttonClass, inputClass } from "@/components/ui";

export function AcceptInviteForm({ token, hasAccount }: { token: string; hasAccount: boolean }) {
  const [state, action] = useActionState(acceptInviteAction, INITIAL_STATE);
  const [pending, start] = useTransition();
  if (state.ok && state.message) {
    return (
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-emerald-800">{state.message}</p>
        <Link href="/sign-in" className={buttonClass("primary")}>
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(() => action(fd));
      }}
    >
      <input type="hidden" name="token" value={token} />
      {hasAccount ? (
        <p className="text-sm text-slate-600">You already have an account. Accept to add access, then sign in with your existing password.</p>
      ) : (
        <>
          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              Choose a password (12+ characters)
            </label>
            <input id="password" name="password" type="password" minLength={12} required autoComplete="new-password" className={`${inputClass} mt-1`} />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-sm font-medium">
              Confirm password
            </label>
            <input id="confirm" name="confirm" type="password" minLength={12} required autoComplete="new-password" className={`${inputClass} mt-1`} />
          </div>
        </>
      )}
      {!state.ok && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button disabled={pending} className={`${buttonClass("primary")} w-full`}>
        {pending ? "Saving…" : "Accept invitation"}
      </button>
    </form>
  );
}
