import { redirect } from "next/navigation";
import { getCtx, getSessionUser } from "@/server/auth/session";

export default async function Home() {
  const ctx = await getCtx();
  if (!ctx) redirect((await getSessionUser()) ? "/no-access" : "/sign-in");
  redirect(ctx.role === "EXTERNAL" ? "/portal" : "/dashboard");
}
