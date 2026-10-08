"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_COMPANY_COOKIE, getMemberships, getSessionUser } from "@/server/auth/session";

/** Switches the active company. Only companies with an active membership are accepted. */
export async function switchCompanyAction(companyId: string) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const memberships = await getMemberships(user.id);
  if (!memberships.some((m) => m.companyId === companyId)) return;
  (await cookies()).set(ACTIVE_COMPANY_COOKIE, companyId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/dashboard");
}
