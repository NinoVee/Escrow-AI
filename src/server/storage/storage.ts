import { promises as fs } from "node:fs";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";
import { hmacHex, safeEqualHex } from "../crypto";
import { db } from "../db";

/**
 * Private document storage. Objects are never publicly readable. Downloads go
 * through an authorization check in the app, which then issues a short-lived
 * signed URL (S3 presigned URL, or an HMAC-signed app URL for local disk and
 * database storage).
 */
export interface StorageDriver {
  readonly kind: "local" | "s3" | "database";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  move(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
  signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string>;
}

export interface SignedUrlOptions {
  filename: string;
  contentType: string;
  ttlSeconds: number;
  /** Local driver binds the link to the requesting user. */
  userId: string;
}

const KEY_RE = /^[a-zA-Z0-9/_\-.]+$/;
function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key");
}

class LocalStorage implements StorageDriver {
  readonly kind = "local" as const;
  constructor(private root: string) {}
  private full(key: string) {
    assertKey(key);
    return path.join(path.resolve(this.root), key);
  }
  async put(key: string, data: Buffer) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string) {
    return fs.readFile(this.full(key));
  }
  async move(from: string, to: string) {
    const dest = this.full(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(this.full(from), dest);
  }
  async remove(key: string) {
    await fs.rm(this.full(key), { force: true });
  }
  async signedDownloadUrl(key: string, opts: SignedUrlOptions) {
    const token = signLocalToken({ k: key, f: opts.filename, ct: opts.contentType, u: opts.userId, exp: Math.floor(Date.now() / 1000) + opts.ttlSeconds });
    return `/api/files/${token}`;
  }
}

/**
 * Stores objects in PostgreSQL (StoredObject). Private like the other drivers;
 * downloads use the same user-bound, short-lived signed app URLs as local disk.
 * Intended for demos and small deployments without object storage (e.g. Vercel
 * with uploads capped at 4 MB); use S3 for production volumes.
 */
class DatabaseStorage implements StorageDriver {
  readonly kind = "database" as const;
  async put(key: string, data: Buffer, contentType: string) {
    assertKey(key);
    const bytes = new Uint8Array(data);
    await db.storedObject.upsert({ where: { key }, create: { key, data: bytes, contentType, size: data.length }, update: { data: bytes, contentType, size: data.length } });
  }
  async get(key: string) {
    assertKey(key);
    const o = await db.storedObject.findUnique({ where: { key } });
    if (!o) throw new Error("Object not found");
    return Buffer.from(o.data);
  }
  async move(from: string, to: string) {
    assertKey(from);
    assertKey(to);
    await db.storedObject.update({ where: { key: from }, data: { key: to } });
  }
  async remove(key: string) {
    assertKey(key);
    await db.storedObject.deleteMany({ where: { key } });
  }
  async signedDownloadUrl(key: string, opts: SignedUrlOptions) {
    assertKey(key);
    const token = signLocalToken({ k: key, f: opts.filename, ct: opts.contentType, u: opts.userId, exp: Math.floor(Date.now() / 1000) + opts.ttlSeconds });
    return `/api/files/${token}`;
  }
}

class S3Storage implements StorageDriver {
  readonly kind = "s3" as const;
  private client: S3Client;
  constructor(private bucket: string) {
    const e = env();
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
      credentials: e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }
  async put(key: string, data: Buffer, contentType: string) {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    assertKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async move(from: string, to: string) {
    assertKey(from);
    assertKey(to);
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${from}`, Key: to, ServerSideEncryption: "AES256" }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
  }
  async remove(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async signedDownloadUrl(key: string, opts: SignedUrlOptions) {
    assertKey(key);
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${opts.filename.replace(/[^\w.\- ]/g, "_")}"`,
      ResponseContentType: opts.contentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.ttlSeconds });
  }
}

let driver: StorageDriver | undefined;
export function storage(): StorageDriver {
  if (!driver) {
    const e = env();
    if (e.STORAGE_DRIVER === "s3") {
      if (!e.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
      driver = new S3Storage(e.S3_BUCKET);
    } else if (e.STORAGE_DRIVER === "database") {
      driver = new DatabaseStorage();
    } else {
      if (process.env.VERCEL === "1") throw new Error("STORAGE_DRIVER=local cannot be used on Vercel: function file systems are temporary. Set STORAGE_DRIVER=database (demos) or STORAGE_DRIVER=s3 with the S3_* variables (see docs/DEPLOY-VERCEL.md).");
      driver = new LocalStorage(e.STORAGE_LOCAL_DIR);
    }
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Local signed tokens: base64url(payload).hmac
// ---------------------------------------------------------------------------

export interface LocalTokenPayload {
  k: string;
  f: string;
  ct: string;
  u: string;
  exp: number;
}

export function signLocalToken(payload: LocalTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacHex(env().DOWNLOAD_SIGNING_SECRET, body)}`;
}

export function verifyLocalToken(token: string): LocalTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !/^[0-9a-f]+$/.test(sig)) return null;
  if (!safeEqualHex(sig, hmacHex(env().DOWNLOAD_SIGNING_SECRET, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LocalTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
