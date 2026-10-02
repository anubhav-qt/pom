import { withBasePath } from "@/lib/base-path";

/**
 * Sending a clip to POST /api/seelie/assets in pieces (the tunnel takes up to 100 MB a
 * request): XHR for the progress bar, and a piece that fails is sent again from where
 * the server says it got to.
 */

export const MAX_CLIP_BYTES = 300 * 1024 * 1024;
const PIECE = 32 * 1024 * 1024;
const TRIES = 4;

export interface UploadedAsset {
  id: number;
  ref: string;
  kind: string;
  name: string;
  mime: string;
  seconds?: number;
  size?: string;
}

export class UploadError extends Error {}

interface PieceAnswer {
  status: number;
  body: { received?: number; asset?: UploadedAsset; error?: string } | null;
}

function sendPiece(file: File, upload: string, offset: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<PieceAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", withBasePath("/api/seelie/assets"));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upload", upload);
    xhr.setRequestHeader("x-offset", String(offset));
    xhr.setRequestHeader("x-total", String(file.size));
    xhr.setRequestHeader("x-name", encodeURIComponent(file.name));
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response });
    xhr.onerror = () => reject(new UploadError("The connection dropped."));
    xhr.ontimeout = () => reject(new UploadError("The upload timed out."));
    const abort = () => xhr.abort();
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.send(file.slice(offset, Math.min(file.size, offset + PIECE)));
  });
}

/** Upload `file`; `onProgress` gets the share sent (0–1). Resolves with the saved asset. */
export async function uploadClip(file: File, opts: { signal: AbortSignal; onProgress: (share: number) => void }): Promise<UploadedAsset> {
  if (file.size > MAX_CLIP_BYTES) throw new UploadError(`${file.name} is ${Math.round(file.size / 1048576)} MB; the limit is 300 MB.`);
  if (file.size === 0) throw new UploadError(`${file.name} is empty.`);
  const upload = crypto.randomUUID();
  let offset = 0;
  let failures = 0;
  for (;;) {
    let answer: PieceAnswer;
    try {
      answer = await sendPiece(file, upload, offset, opts.signal, (n) => opts.onProgress(Math.min(1, (offset + n) / file.size)));
    } catch (err) {
      if (opts.signal.aborted || ++failures >= TRIES) throw err;
      await new Promise((ok) => setTimeout(ok, 1500 * failures));
      continue;
    }
    const { status, body } = answer;
    if (status === 409 && typeof body?.received === "number") {
      offset = body.received;
      continue;
    }
    if (status >= 500 && ++failures < TRIES) {
      await new Promise((ok) => setTimeout(ok, 1500 * failures));
      continue;
    }
    if (status < 200 || status >= 300) throw new UploadError(body?.error ?? `The upload failed (${status}).`);
    if (body?.asset) {
      opts.onProgress(1);
      return body.asset;
    }
    if (typeof body?.received !== "number") throw new UploadError("The server's answer made no sense.");
    offset = body.received;
    failures = 0;
  }
}
