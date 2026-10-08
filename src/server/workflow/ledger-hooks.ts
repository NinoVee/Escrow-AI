import type { Tx } from "../db";
import type { db } from "../db";

/**
 * Ledger-dependent closing checks used by the workflow engine:
 * - the escrow file's balance in the internal tracking ledger must be zero;
 * - no disbursement may be left prepared, pending or approved but unreleased.
 */
export async function fileBalanceCents(client: Tx | typeof db, transactionId: string): Promise<bigint> {
  const rows = await client.$queryRaw<{ bal: bigint | null }[]>`
    SELECT COALESCE(SUM(l."creditCents" - l."debitCents"), 0)::bigint AS bal
    FROM "JournalLine" l JOIN "LedgerAccount" a ON a."id" = l."accountId"
    WHERE a."purpose" = 'ESCROW_LIABILITY' AND l."transactionId" = ${transactionId}`;
  return rows[0]?.bal ?? 0n;
}

export async function openDisbursementCount(client: Tx | typeof db, transactionId: string): Promise<number> {
  return client.disbursement.count({ where: { transactionId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } } });
}
