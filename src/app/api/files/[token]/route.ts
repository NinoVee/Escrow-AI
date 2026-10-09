import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { storage, verifyLocalToken } from "@/server/storage/storage";

/**
 * Serves files for the local-disk and database storage drivers. The token is HMAC-signed,
 * expires within DOWNLOAD_LINK_TTL_SECONDS, and is bound to the user who
 * requested it; a leaked link is useless to anyone else.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = verifyLocalToken(token);
  if (!payload) return NextResponse.json({ error: "Link expired or invalid" }, { status: 403 });
  const user = await getSessionUser();
  if (!user || user.id !== payload.u) return NextResponse.json({ error: "Link expired or invalid" }, { status: 403 });
  if (storage().kind === "s3") return NextResponse.json({ error: "Not available" }, { status: 404 });
  const data = await storage().get(payload.k);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": payload.ct,
      "Content-Disposition": `attachment; filename="${payload.f.replace(/[^\w.\- ()]/g, "_")}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
