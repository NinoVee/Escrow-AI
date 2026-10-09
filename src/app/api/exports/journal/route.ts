import { NextResponse } from "next/server";
import { getCtx } from "@/server/auth/session";
import { exportJournalCsv } from "@/server/services/integrations";
import { isAppError } from "@/server/errors";
import { log } from "@/server/logger";

/** Accounting export: journal lines as CSV for import into the general ledger system. */
export async function GET(request: Request) {
  const ctx = await getCtx();
  if (!ctx || ctx.role === "EXTERNAL") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const url = new URL(request.url);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  try {
    const csv = await exportJournalCsv(ctx, from, to);
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="journal-${from ?? "all"}-${to ?? "all"}.csv"`, "Cache-Control": "no-store" } });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json({ error: e.message }, { status: e.code === "FORBIDDEN" ? 403 : 400 });
    log.error("export failed", { error: e });
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
