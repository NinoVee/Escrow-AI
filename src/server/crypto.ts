import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Field-level encryption for sensitive values (bank account and routing
 * numbers). AES-256-GCM with a random 96-bit IV. Ciphertext format:
 *   v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 * Key rotation: add a new key id and re-encrypt; see docs/SECURITY.md.
 */
const KEY_ID = "k1";

function key(): Buffer {
  const raw = Buffer.from(env().FIELD_ENCRYPTION_KEY, "base64");
  if (raw.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return raw;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", KEY_ID, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptField(payload: string): string {
  const [v, keyId, ivB64, tagB64, ctB64] = payload.split(":");
  if (v !== "v1" || keyId !== KEY_ID) throw new Error("Unsupported ciphertext version");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Canonical JSON (sorted keys, bigint as string) for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function mask(value: string, visible = 4): string {
  const digits = value.replace(/\s/g, "");
  if (digits.length <= visible) return "•".repeat(digits.length);
  return "•".repeat(Math.min(8, digits.length - visible)) + digits.slice(-visible);
}
