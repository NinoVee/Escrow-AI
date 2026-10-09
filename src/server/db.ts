import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createClient() {
  // Serverless instances each hold their own pool; keep it small and use a pooled DATABASE_URL.
  const max = Number(process.env.DB_POOL_MAX) || (process.env.VERCEL === "1" ? 3 : 10);
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max });
  return new PrismaClient({ adapter });
}

export const db: PrismaClient = globalForPrisma.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = db;

export type Db = PrismaClient;
/** Interactive transaction client type. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
