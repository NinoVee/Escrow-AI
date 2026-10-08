"use client";

import { buttonClass } from "@/components/ui";

export function PrintButton() {
  return (
    <button type="button" className={buttonClass("secondary", "sm")} onClick={() => window.print()}>
      Print draft
    </button>
  );
}
