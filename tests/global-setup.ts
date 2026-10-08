import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Applies migrations to the test database once per run. */
export default function setup() {
  config();
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/escrowflow(\?|$)/, "/escrowflow_test$1");
  if (!url || !/test/.test(url)) throw new Error("Refusing to run tests: TEST_DATABASE_URL must point at a database whose name contains 'test'.");
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
