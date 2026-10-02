import "server-only";

import { Type, type ImageContent } from "@paribelle/pi-ai";

import { defineTool, ToolError } from "./types";

const MAX_BYTES = 10 * 1024 * 1024;

/** Only public https hosts: no localhost, no bare IPs, nothing inside the server's network. */
export function publicHttps(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return null;
  return url;
}

/** A public https URL's response, redirects checked hop by hop, refused past `maxBytes`. */
export async function fetchPublic(
  raw: string,
  signal: AbortSignal,
  opts: { maxBytes: number; timeoutMs?: number; accept?: string },
): Promise<{ bytes: Buffer; type: string; url: string }> {
  let url = publicHttps(raw);
  if (!url) throw new ToolError(`${raw.slice(0, 120)} isn't a public https URL.`);
  const get = (u: URL) =>
    fetch(u, {
      redirect: "manual",
      headers: { "user-agent": "Seelie/1.0 (Paribelle OMS; +https://paribelle.in)", ...(opts.accept ? { accept: opts.accept } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)]),
    });
  let res = await get(url);
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    const next = publicHttps(new URL(res.headers.get("location") ?? "", url).toString());
    if (!next) throw new ToolError(`${raw.slice(0, 120)} redirects somewhere it can't be fetched from.`);
    url = next;
    res = await get(url);
  }
  if (!res.ok) throw new ToolError(`${raw.slice(0, 120)}: HTTP ${res.status}`);
  const mb = Math.round(opts.maxBytes / 1024 / 1024);
  if (Number(res.headers.get("content-length") ?? 0) > opts.maxBytes) throw new ToolError(`${raw.slice(0, 120)} is larger than ${mb} MB.`);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    size += r.value.length;
    if (size > opts.maxBytes) {
      await reader!.cancel().catch(() => {});
      throw new ToolError(`${raw.slice(0, 120)} is larger than ${mb} MB.`);
    }
    chunks.push(Buffer.from(r.value));
  }
  return { bytes: Buffer.concat(chunks), type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), url: url.toString() };
}

/** An image from a public https URL. */
export async function fetchImage(raw: string, signal: AbortSignal): Promise<Buffer> {
  const { bytes, type } = await fetchPublic(raw, signal, { maxBytes: MAX_BYTES });
  if (!/^image\/(jpeg|png|webp|gif|avif)/.test(type)) throw new ToolError(`${raw.slice(0, 120)} isn't an image (${type || "unknown type"}).`);
  return bytes;
}

/** Any image as a JPEG no longer than `edge` on its long side. */
export async function toJpeg(bytes: Buffer, edge: number, quality = 85): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(bytes);
  const scale = Math.min(1, edge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // JPEG has no transparency: a cut-out goes on white, not black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.encode("jpeg", quality);
}

export const viewImages = defineTool({
  name: "view_images",
  label: "Look at images",
  description:
    "Look at images on the web (product photos from the OMS, Amazon or paribelle.in, by their https URLs) to describe, compare or check them. Up to 6 at a time.",
  parameters: Type.Object({ urls: Type.Array(Type.String(), { minItems: 1, maxItems: 6 }) }),
  kind: "read",
  summary: (a) => `${a.urls.length} image${a.urls.length === 1 ? "" : "s"}`,
  async execute(a, ctx) {
    const images: ImageContent[] = [];
    const notes: string[] = [];
    for (const [i, raw] of a.urls.entries()) {
      try {
        const jpeg = await toJpeg(await fetchImage(raw, ctx.signal), 1280);
        images.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
        notes.push(`${i + 1}: shown`);
      } catch (err) {
        notes.push(`${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (images.length === 0) throw new ToolError(`None could be shown. ${notes.join("; ")}`);
    return { text: notes.join("\n"), images };
  },
});
