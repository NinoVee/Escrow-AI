-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('RECEIPT', 'DISBURSEMENT', 'FEE', 'ADJUSTMENT', 'PAYOFF', 'TRANSFER', 'REVERSAL', 'OPENING');

-- CreateEnum
CREATE TYPE "InstructionStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RECORDED_AS_RELEASED', 'INVALIDATED', 'CANCELLED');

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entryNumber" INTEGER NOT NULL,
    "transactionId" TEXT,
    "effectiveDate" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "kind" "EntryKind" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "reversesEntryId" TEXT,
    "postedById" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "transactionId" TEXT,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "payee" TEXT,
    "amountCents" BIGINT,
    "chargeTo" TEXT NOT NULL DEFAULT 'BUYER',
    "buyerShareBps" INTEGER,
    "proration" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settlementDate" DATE NOT NULL,
    "conventions" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "endingBalanceCents" BIGINT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "newRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "postedDate" DATE NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "matchedEntryId" TEXT,
    "matchedById" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "bankBalanceCents" BIGINT NOT NULL,
    "bookBalanceCents" BIGINT NOT NULL,
    "fileBalancesTotalCents" BIGINT NOT NULL,
    "outstandingDepositsCents" BIGINT NOT NULL,
    "outstandingChecksCents" BIGINT NOT NULL,
    "adjustedBankCents" BIGINT NOT NULL,
    "bankVsBookCents" BIGINT NOT NULL,
    "bookVsFilesCents" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "preparedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankInstruction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payeeName" TEXT NOT NULL,
    "payeeParticipantId" TEXT,
    "bankName" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "routingNumberEnc" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "routingLast4" TEXT NOT NULL,
    "receivedVia" TEXT NOT NULL,
    "status" "InstructionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankInstructionVerification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "instructionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phoneLast4" TEXT,
    "phoneSource" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notes" TEXT,
    "evidenceDocumentId" TEXT,
    "verifiedById" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,

    CONSTRAINT "BankInstructionVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Disbursement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "instructionId" TEXT,
    "memo" TEXT,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "preparedById" TEXT NOT NULL,
    "approvalId" TEXT,
    "invalidatedReason" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "externalReference" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Disbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_companyId_code_key" ON "LedgerAccount"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesEntryId_key" ON "JournalEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_transactionId_idx" ON "JournalEntry"("companyId", "transactionId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_effectiveDate_idx" ON "JournalEntry"("companyId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_entryNumber_key" ON "JournalEntry"("companyId", "entryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_idempotencyKey_key" ON "JournalEntry"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JournalLine_companyId_accountId_transactionId_idx" ON "JournalLine"("companyId", "accountId", "transactionId");

-- CreateIndex
CREATE INDEX "SettlementItem_companyId_transactionId_idx" ON "SettlementItem"("companyId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementStatement_transactionId_version_key" ON "SettlementStatement"("transactionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementImport_bankAccountId_fileSha256_key" ON "BankStatementImport"("bankAccountId", "fileSha256");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_matchedEntryId_key" ON "BankTransaction"("matchedEntryId");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_bankAccountId_postedDate_idx" ON "BankTransaction"("companyId", "bankAccountId", "postedDate");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_externalId_key" ON "BankTransaction"("bankAccountId", "externalId");

-- CreateIndex
CREATE INDEX "Reconciliation_companyId_bankAccountId_periodEnd_idx" ON "Reconciliation"("companyId", "bankAccountId", "periodEnd");

-- CreateIndex
CREATE INDEX "BankInstruction_companyId_transactionId_idx" ON "BankInstruction"("companyId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankInstruction_groupId_version_key" ON "BankInstruction"("groupId", "version");

-- CreateIndex
CREATE INDEX "Disbursement_companyId_transactionId_status_idx" ON "Disbursement"("companyId", "transactionId", "status");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankInstructionVerification" ADD CONSTRAINT "BankInstructionVerification_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "BankInstruction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ledger integrity (hand-written)
-- ---------------------------------------------------------------------------

-- Each line is one-sided and non-negative.
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_sided"
  CHECK ("debitCents" >= 0 AND "creditCents" >= 0 AND (("debitCents" = 0) <> ("creditCents" = 0)));

-- Every entry must balance (debits = credits) and have at least two lines.
-- Checked at COMMIT so lines can be inserted one at a time inside a transaction.
CREATE OR REPLACE FUNCTION ef_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  d NUMERIC; c NUMERIC; n INT;
BEGIN
  SELECT COALESCE(SUM("debitCents"),0), COALESCE(SUM("creditCents"),0), COUNT(*)
    INTO d, c, n FROM "JournalLine" WHERE "entryId" = NEW."entryId";
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (debits %, credits %, lines %)', NEW."entryId", d, c, n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ef_check_entry_balanced();

-- Posted entries and lines are immutable; corrections are reversal entries.
CREATE TRIGGER journal_entry_immutable
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION ef_reject_mutation();

CREATE TRIGGER journal_line_immutable
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION ef_reject_mutation();
