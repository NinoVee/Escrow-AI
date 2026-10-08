import { NextResponse } from "next/server";
import { getCtx } from "@/server/auth/session";
import { getDownloadUrl } from "@/server/services/documents";
import { isAppError } from "@/server/errors";
import { log } from "@/server/logger";

/**
 * Authorization gate for downloads. Checks tenant and participant access, then
 * redirects to a short-lived signed URL. Nothing is cached.
 */
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const { versionId } = await params;
  try {
    const { url } = await getDownloadUrl(ctx, versionId);
    const res = NextResponse.redirect(new URL(url, request.url), 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    if (isAppError(e)) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    log.error("download failed", { error: e });
    return NextResponse.json({ error: "Download failed" }, { status: 500 });
  }
}
