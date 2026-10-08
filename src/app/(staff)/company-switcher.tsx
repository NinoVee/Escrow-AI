"use client";

import { useTransition } from "react";
import { switchCompanyAction } from "./actions";

export function CompanySwitcher({ current, options }: { current: string; options: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Company</span>
      <select
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
        value={current}
        disabled={pending}
        onChange={(e) => start(() => switchCompanyAction(e.target.value))}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
