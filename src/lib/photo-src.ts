import { withBasePath } from "./base-path";

/**
 * Catalogue photos Seelie publishes to the OMS live on paribelle.in's Cloudinary and, as
 * a copy, on the ThinkPad. Their URL carries this mark (a fragment, so Cloudinary and
 * every other reader ignore it); the OMS loads them through /api/photos, which serves
 * the copy when this server has it and redirects to Cloudinary when it doesn't.
 */
export const LOCAL_COPY_MARK = "#oms-local";

export function photoSrc(src: string) {
  if (!src.endsWith(LOCAL_COPY_MARK)) return src;
  return withBasePath(`/api/photos?src=${encodeURIComponent(src.slice(0, -LOCAL_COPY_MARK.length))}`);
}
