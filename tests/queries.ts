import { db } from "@/server/db";
import type { Ctx } from "@/server/context";
import { loadTransaction } from "@/server/services/access";

/** Mirrors how pages read tasks: always behind loadTransaction. */
export async function listTasksForTest(ctx: Ctx, transactionId: string) {
  const tx = await loadTransaction(ctx, transactionId);
  return db.task.findMany({ where: { transactionId: tx.id } });
}
