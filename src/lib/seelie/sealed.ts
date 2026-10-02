import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets Seelie keeps in seelie_settings (the paribelle.in password, the Instagram
 * token), encrypted AES-256-GCM with a key derived from AUTH_SECRET and what the
 * secret is for. A changed AUTH_SECRET makes them unreadable: the owner enters them again.
 */

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

function key(purpose: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(`seelie-${purpose}:${secret}`).digest();
}

export function seal(plain: string, purpose: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function unseal(box: Sealed, purpose: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
}
