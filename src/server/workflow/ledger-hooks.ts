import type { Tx } from "../db";
import type { db } from "../db";

/**
 * Ledger-dependent closing checks. Phase 1 has no ledger, so these report a
 * zero balance and no open disbursements. Phase 3 replaces them with real
 * queries against the internal tracking ledger.
 */
export async function fileBalanceCents(_client: Tx | typeof db, _transactionId: string): Promise<bigint> {
  return 0n;
}

export async function openDisbursementCount(_client: Tx | typeof db, _transactionId: string): Promise<number> {
  return 0;
}
