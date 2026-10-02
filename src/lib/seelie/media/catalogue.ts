import "server-only";

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { mediaFolder, mediaPath } from "./files";

/**
 * The ThinkPad's copies of OMS catalogue photos (catalogue/ in the media folder), named
 * by their Cloudinary URL, so the OMS on the laptop never waits on Cloudinary for them.
 */

/** Only paribelle.in's image host. */
export const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/[^\s#?]+$/;

export const localCopyFile = (url: string) => mediaPath("catalogue", `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.jpg`);

export async function saveLocalCopy(url: string, jpeg: Buffer) {
  await mediaFolder("catalogue");
  await writeFile(localCopyFile(url), jpeg);
}
