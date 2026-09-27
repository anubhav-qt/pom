import { createHash, createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data: string) => createHash("sha256").update(data).digest("hex");

/**
 * Uploads a file with one signed PUT (AWS Signature V4, path-style, unsigned
 * payload). R2 takes single PUTs up to 5 GB, far more than a night's dump.
 */
export async function putFile(cfg: S3Config, key: string, file: string, contentType = "application/octet-stream") {
  const size = statSync(file).size;
  const url = new URL(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "content-length": String(size),
    "content-type": contentType,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": amzDate,
  };
  const signed = Object.keys(headers).sort();
  const canonical = [
    "PUT",
    url.pathname,
    "",
    ...signed.map((h) => `${h}:${headers[h]}`),
    "",
    signed.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;

  // Signed, but fetch sets Host itself.
  const { host: _host, ...sent } = headers;
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  const res = await fetch(url, { method: "PUT", headers: sent, body, duplex: "half" } as RequestInit);
  if (!res.ok) throw new Error(`upload of ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}
