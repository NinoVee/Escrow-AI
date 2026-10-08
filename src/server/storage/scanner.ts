import net from "node:net";
import { env } from "../env";

/**
 * Malware scanning boundary. Uploads land in quarantine and are only released
 * (made downloadable) after a CLEAN result.
 *
 * - "demo": detects the industry-standard EICAR test string only. It is NOT
 *   antivirus protection and is labeled as such in the UI.
 * - "clamav": streams the file to a clamd daemon using the documented INSTREAM
 *   command (https://docs.clamav.net/manual/Usage/Scanning.html#clamd).
 */
export interface ScanResult {
  status: "CLEAN" | "INFECTED" | "ERROR";
  provider: string;
  detail: string;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export async function scanBuffer(buf: Buffer): Promise<ScanResult> {
  const mode = env().MALWARE_SCANNER;
  if (mode === "clamav") return scanWithClamd(buf);
  if (mode === "none") return { status: "ERROR", provider: "none", detail: "No malware scanner configured; file held in quarantine." };
  const infected = buf.includes(Buffer.from(EICAR, "latin1"));
  return infected
    ? { status: "INFECTED", provider: "demo", detail: "Demo scanner matched the EICAR test signature." }
    : { status: "CLEAN", provider: "demo", detail: "Demo scanner: EICAR test-signature check only. Not real antivirus protection." };
}

function scanWithClamd(buf: Buffer): Promise<ScanResult> {
  const { CLAMAV_HOST, CLAMAV_PORT } = env();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let reply = "";
    const done = (r: ScanResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(30_000, () => done({ status: "ERROR", provider: "clamav", detail: "Scanner timed out" }));
    socket.on("error", (e) => done({ status: "ERROR", provider: "clamav", detail: `Scanner unavailable: ${e.message}` }));
    socket.on("data", (d) => (reply += d.toString("utf8")));
    socket.on("end", () => {
      const r = reply.replace(/\0/g, "").trim();
      if (/:\s*OK$/.test(r)) done({ status: "CLEAN", provider: "clamav", detail: "clamd: OK" });
      else if (/FOUND$/.test(r)) done({ status: "INFECTED", provider: "clamav", detail: `clamd: ${r}` });
      else done({ status: "ERROR", provider: "clamav", detail: `clamd: ${r || "no response"}` });
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let i = 0; i < buf.length; i += CHUNK) {
        const chunk = buf.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
