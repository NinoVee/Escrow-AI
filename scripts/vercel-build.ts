/**
 * Vercel build: `npm run vercel-build` (set as the build command in vercel.json).
 * 1. Checks the environment and fails fast with clear messages.
 * 2. Applies database migrations on production builds (or when MIGRATE_ON_BUILD=true).
 *    Preview builds skip migrations by default so a branch never migrates the
 *    production database; point previews at their own database to migrate them.
 * 3. Optionally loads FICTIONAL demo data (SEED_DEMO_DATA=true; skipped if already present).
 * 4. Generates the Prisma client and runs `next build`.
 */
import { spawnSync } from "node:child_process";

const env = process.env;
const errors: string[] = [];
const warnings: string[] = [];

function need(name: string, check: (v: string) => boolean = Boolean, hint = "") {
  const v = env[name];
  if (!v || !check(v)) errors.push(`${name} ${v ? "is invalid" : "is not set"}${hint ? ` (${hint})` : ""}`);
}

need("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "PostgreSQL URL; use your provider's pooled connection string");
need("BETTER_AUTH_SECRET", (v) => v.length >= 32, "openssl rand -base64 48");
need("DOWNLOAD_SIGNING_SECRET", (v) => v.length >= 32, "openssl rand -base64 48");
need("FIELD_ENCRYPTION_KEY", (v) => Buffer.from(v, "base64").length === 32, "32 bytes, base64: openssl rand -base64 32");
if (env.VERCEL === "1" && env.STORAGE_DRIVER !== "s3" && env.STORAGE_DRIVER !== "database") errors.push('STORAGE_DRIVER must be "database" (simplest; documents stored in PostgreSQL) or "s3" on Vercel, because function file systems are temporary');
else if (env.STORAGE_DRIVER === "s3") for (const n of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) need(n);
if (env.JOBS_MODE === "queue") warnings.push("JOBS_MODE=queue needs a separately hosted BullMQ worker; Vercel cannot run it. Leave JOBS_MODE unset to use deferred jobs.");
if (!env.CRON_SECRET) warnings.push("CRON_SECRET is not set: failed jobs will not be retried and automation rules will not run on schedule.");
if (env.MALWARE_SCANNER !== "clamav") warnings.push(`MALWARE_SCANNER=${env.MALWARE_SCANNER ?? "demo"}: uploads are not really scanned (demo detects only EICAR; "none" keeps every upload quarantined).`);
if (env.EXTERNAL_SEND_ENABLED === "true") warnings.push("EXTERNAL_SEND_ENABLED=true: approved emails can leave the system once a company also enables sending.");
if (env.SEED_DEMO_DATA === "true") warnings.push("SEED_DEMO_DATA=true: demo accounts with PUBLISHED passwords will exist. Turn on Vercel Deployment Protection, and remove this variable once seeded.");
if (env.VERCEL_ENV === "production" && !env.APP_URL) warnings.push("APP_URL is not set; using the Vercel production domain. Set it if you use a custom domain.");

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error("\nEscrowFlow cannot be built for Vercel until these are fixed (see docs/DEPLOY-VERCEL.md):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

function run(cmd: string, args: string[]) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const migrate = env.MIGRATE_ON_BUILD ? env.MIGRATE_ON_BUILD === "true" : env.VERCEL_ENV === "production";
// Generate explicitly: newer npm versions may skip install scripts (including postinstall).
run("npx", ["prisma", "generate"]);
if (migrate) run("npx", ["prisma", "migrate", "deploy"]);
else console.log("Skipping database migrations (preview build). Set MIGRATE_ON_BUILD=true to apply them.");
if (env.SEED_DEMO_DATA === "true") {
  if (!migrate) console.log("Skipping demo data: migrations were not applied in this build.");
  else run("npx", ["tsx", "prisma/seed.ts"]);
}
run("npx", ["next", "build"]);
