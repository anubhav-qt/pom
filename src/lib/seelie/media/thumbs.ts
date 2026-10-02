import "server-only";

import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";

import { decode, preview } from "../studio/raster";
import { mediaFolder, mediaPath, thumbFile, type AssetRow, type ThumbEdge } from "./files";

/**
 * Small JPEGs of image assets for the chat (a 4K shoot picture is ~9 MB), made once and
 * kept in cache/thumbs/. Transparent pictures show on a checkerboard.
 */

export { THUMB_EDGES } from "./files";

export async function thumbnail(asset: AssetRow, edge: ThumbEdge): Promise<string> {
  const file = thumbFile(asset.id, edge);
  if (await stat(file).then((s) => s.isFile(), () => false)) return file;
  await mediaFolder("cache", "thumbs");
  const r = await decode(await readFile(mediaPath(asset.file)), edge);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, await preview(r, edge, 82));
  await rename(tmp, file);
  return file;
}
