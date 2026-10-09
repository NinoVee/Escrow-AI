import { z } from "zod";

/**
 * Server environment. Secrets come only from environment variables and are
 * never sent to the browser. Missing optional integration credentials put the
 * matching integration into "Not configured" or "Demo" mode instead of failing.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),

  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** base64-encoded 32-byte key for AES-256-GCM field encryption */
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  /** HMAC key for short-lived download links and webhook test signatures */
  DOWNLOAD_SIGNING_SECRET: z.string().min(32),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-west-2"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),

  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(60),

  MALWARE_SCANNER: z.enum(["demo", "clamav", "none"]).default("demo"),
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** "auto" uses Anthropic when a key is present, otherwise the demo adapter. */
  AI_PROVIDER: z.enum(["auto", "anthropic", "demo"]).default("auto"),
  OCR_PROVIDER: z.enum(["anthropic", "none"]).default("anthropic"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  /** Global kill switch. External email is never sent unless this is "true". */
  EXTERNAL_SEND_ENABLED: z.enum(["true", "false"]).default("false"),

  ESIGN_WEBHOOK_SECRET: z.string().optional(),
  RECORDING_WEBHOOK_SECRET: z.string().optional(),
  TITLE_WEBHOOK_SECRET: z.string().optional(),

  ATTOM_API_KEY: z.string().optional(),
  DATATREE_CLIENT_ID: z.string().optional(),
  DATATREE_CLIENT_SECRET: z.string().optional(),
  QUALIA_API_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid server environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests that mutate process.env. */
export function resetEnvCache() {
  cached = undefined;
}
