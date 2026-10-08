"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { INITIAL_STATE, type ActionState, type FormAction } from "@/lib/action-types";
import { stepUpAction } from "@/app/actions/stepup";
import { buttonClass, cn, inputClass } from "./ui";

interface Props<T> {
  action: FormAction<T>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  className?: string;
  /** Native confirm() prompt before submitting */
  confirm?: string;
  resetOnSuccess?: boolean;
  inline?: boolean;
  onSuccess?: (state: ActionState<T>) => void;
  renderResult?: (data: T) => ReactNode;
}

/**
 * Form bound to a server action. Keeps field values on error, shows the
 * server's message, and when the server requires step-up authentication it
 * prompts for an authenticator code in place, then asks the user to resubmit.
 */
export function ActionForm<T>({ action, children, submitLabel, pendingLabel, variant = "primary", size = "md", className, confirm, resetOnSuccess = true, inline, onSuccess, renderResult }: Props<T>) {
  const [state, formAction] = useActionState<ActionState<T>, FormData>(action, INITIAL_STATE as ActionState<T>);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const [submitted, setSubmitted] = useState(0);

  useEffect(() => {
    if (submitted === 0) return;
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.(state);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, submitted]);

  return (
    <div className={className}>
      <form
        ref={ref}
        className={inline ? "flex flex-wrap items-end gap-2" : "space-y-3"}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm && !window.confirm(confirm)) return;
          const fd = new FormData(e.currentTarget);
          startTransition(() => {
            formAction(fd);
            setSubmitted((n) => n + 1);
          });
        }}
      >
        {children}
        <div>
          <button type="submit" disabled={pending} className={buttonClass(variant, size)} aria-busy={pending}>
            {pending ? (pendingLabel ?? "Working…") : submitLabel}
          </button>
        </div>
      </form>
      {submitted > 0 && !pending && <Result state={state} renderResult={renderResult} />}
    </div>
  );
}

function Result<T>({ state, renderResult }: { state: ActionState<T>; renderResult?: (data: T) => ReactNode }) {
  if (state.ok) {
    return (
      <>
        {state.message && (
          <p role="status" className="mt-2 text-sm text-emerald-800">
            {state.message}
          </p>
        )}
        {state.data !== undefined && renderResult ? <div className="mt-2">{renderResult(state.data as T)}</div> : null}
      </>
    );
  }
  if (state.code === "STEP_UP_REQUIRED") return <StepUpPrompt message={state.error} />;
  return (
    <div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
      {state.error}
      {Array.isArray(state.details) && (
        <ul className="mt-1 list-disc pl-5">
          {(state.details as { label?: string; detail?: string }[]).slice(0, 8).map((d, i) => (
            <li key={i}>
              {d.label}
              {d.detail ? `: ${d.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StepUpPrompt({ message }: { message?: string }) {
  const [state, formAction] = useActionState(stepUpAction, INITIAL_STATE);
  const [pending, startTransition] = useTransition();
  const done = state.ok && Boolean(state.message);
  if (done) {
    return (
      <p role="status" className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Identity confirmed for the next few minutes. Submit the action again.
      </p>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
      <p className="font-medium">{message ?? "Confirm your identity to continue."}</p>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(() => formAction(fd));
        }}
      >
        <label className="text-xs font-medium" htmlFor="stepup-code">
          Authenticator code
          <input id="stepup-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className={cn(inputClass, "mt-1 w-32 tabular")} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
      {!state.ok && <p className="mt-1 text-red-800">{state.error}</p>}
    </div>
  );
}
