-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ExtractionRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CONTRACT',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "mode" "IntegrationMode" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "classification" TEXT,
    "classificationConfidence" DOUBLE PRECISION,
    "summary" TEXT,
    "notes" JSONB,
    "output" JSONB,
    "error" TEXT,
    "requestedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantInteraction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "citations" JSONB,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "mode" "IntegrationMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractionRun_companyId_documentId_createdAt_idx" ON "ExtractionRun"("companyId", "documentId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantInteraction_companyId_transactionId_createdAt_idx" ON "AssistantInteraction"("companyId", "transactionId", "createdAt");
