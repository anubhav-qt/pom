import "server-only";

import { readFile } from "node:fs/promises";

import { Type, type ImageContent } from "@paribelle/pi-ai";

import { assetSummary, mediaFolder, MediaError, saveAsset } from "../media/files";
import { cutout } from "../media/cutout";
import { REF_PATTERN, resolveRef } from "../media/refs";
import { GeminiError, generateContent, IMAGE_MODEL, type GeminiPart } from "../gemini";
import { toJpeg } from "./images";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, plural, StringEnum } from "./util";

const ASPECTS = ["1:1", "9:16", "16:9", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "21:9"] as const;

const jpegBlock = (bytes: Buffer): ImageContent => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });

/** An image ref's file and bytes; clips and sounds are refused. */
async function imageOf(ref: string, ctx: ToolContext) {
  if (!REF_PATTERN.test(ref.trim())) throw new ToolError(`"${ref}" isn't a ref (chat:<n> or asset:<id>).`);
  const m = await resolveRef(ref.trim(), { chatImages: ctx.chatImages, workDir: await mediaFolder("cache") });
  if (m.kind !== "image") throw new ToolError(`${ref} isn't an image${m.kind === "video" ? " (video_assets save_frame keeps a still from a clip)" : ""}.`);
  return { name: m.name, bytes: await readFile(m.file) };
}

export const imageStudio = defineTool({
  name: "image_studio",
  label: "Image studio",
  description: [
    "Make images for videos and listings. Results are saved as image assets (asset:<id>) and shown to you.",
    "cutout: remove the background from photos (refs: chat:<n> or image asset:<id>) with a local model; gives transparent PNGs cropped to the subject (trim false keeps the full frame),",
    "ready to overlay in a video_render graph or to pass to generate. The first cut-out downloads the model once (115 MB).",
    `generate: a new image from a prompt with ${IMAGE_MODEL} (Nano Banana 2): scenes, backdrops, textures, props, flat lays. aspect (default 9:16), count 1-4.`,
    "refs: up to 6 reference images it works from: restyle, extend or place a cut-out product in a scene, match a mood. Describe what to keep from each.",
    "A generated image can change a product's details (print, embroidery, colour): for product shots, cut the product out and composite it over a generated scene in the graph,",
    "so the garment stays exactly as it is. Write prompts like a photographer's brief: subject, setting, light, lens, mood, and the empty space the text or product needs.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["cutout", "generate"]),
    refs: optional(Type.Array(Type.String(), { maxItems: 6 })),
    trim: optional(Type.Boolean()),
    prompt: optional(Type.String({ maxLength: 4000 })),
    aspect: optional(StringEnum(ASPECTS)),
    count: optional(Type.Integer({ minimum: 1, maximum: 4 })),
  }),
  kind: "read",
  summary: (a) =>
    a.action === "cutout"
      ? `Cut out ${a.refs?.join(", ") ?? ""}`
      : `Generate ${plural(a.count ?? 1, "image")}${a.refs?.length ? ` from ${a.refs.join(", ")}` : ""}: ${(a.prompt ?? "").slice(0, 80)}`,
  async execute(a, ctx) {
    try {
      if (a.action === "cutout") {
        if (!a.refs?.length) throw new ToolError("Which images (refs)?");
        const out: unknown[] = [];
        const images: ImageContent[] = [];
        for (const [i, ref] of a.refs.entries()) {
          try {
            const src = await imageOf(ref, ctx);
            const cut = await cutout(src.bytes, {
              trim: a.trim !== false,
              signal: ctx.signal,
              progress: (t) => ctx.progress(a.refs!.length > 1 ? `${i + 1} of ${a.refs!.length}: ${t}` : t),
            });
            const row = await saveAsset({
              bytes: cut.png,
              mime: "image/png",
              name: `${src.name} cut out`,
              source: "cutout",
              chatId: ctx.chatId,
              userId: ctx.user.id,
              meta: { from: ref.trim(), coverage: cut.coverage, trimmed: a.trim !== false },
            });
            out.push({ from: ref, ...assetSummary(row), coverage: cut.coverage });
            images.push(jpegBlock(cut.preview));
          } catch (err) {
            if (err instanceof MediaError || err instanceof ToolError) out.push({ from: ref, error: err.message });
            else throw err;
          }
        }
        return { text: images.length ? "Shown on a checkerboard so the edges show; the assets are transparent PNGs." : undefined, data: out, images };
      }

      if (!a.prompt?.trim()) throw new ToolError("What should the image show (prompt)?");
      const refs: GeminiPart[] = [];
      for (const ref of a.refs ?? []) {
        const src = await imageOf(ref, ctx);
        // PNGs go as they are (a cut-out keeps its transparency); anything else as a JPEG.
        const png = src.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const bytes = png && src.bytes.length < 8 * 1024 * 1024 ? src.bytes : await toJpeg(src.bytes, 1536, 90);
        refs.push({ text: `Reference ${ref.trim()}:` }, { inlineData: { mimeType: png ? "image/png" : "image/jpeg", data: bytes.toString("base64") } });
      }
      const aspect = a.aspect ?? "9:16";
      const count = a.count ?? 1;
      const out: unknown[] = [];
      const images: ImageContent[] = [];
      const notes: string[] = [];
      for (let i = 0; i < count; i++) {
        ctx.progress(count > 1 ? `Generating ${i + 1} of ${count}…` : "Generating…");
        const res = await generateContent(
          IMAGE_MODEL,
          {
            contents: [{ role: "user", parts: [...refs, { text: a.prompt.trim() }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: aspect } },
          },
          { signal: ctx.signal, timeoutMs: 180_000 },
        );
        if (res.text) notes.push(res.text.slice(0, 400));
        const image = res.images[0];
        if (!image) {
          out.push({ error: `No image came back${res.text ? `: ${res.text.slice(0, 200)}` : ""}` });
          continue;
        }
        const row = await saveAsset({
          bytes: image.bytes,
          mime: image.mimeType === "image/png" ? "image/png" : image.mimeType === "image/webp" ? "image/webp" : "image/jpeg",
          name: a.prompt.trim().slice(0, 80),
          source: "generated",
          chatId: ctx.chatId,
          userId: ctx.user.id,
          meta: { prompt: a.prompt.trim(), refs: a.refs ?? [], aspect, model: IMAGE_MODEL },
        });
        out.push(assetSummary(row));
        images.push(jpegBlock(await toJpeg(image.bytes, 768)));
      }
      if (!images.length) throw new ToolError(`${IMAGE_MODEL} made no image. ${(out[0] as { error?: string })?.error ?? ""}`.trim());
      return { text: notes.length ? `The model said: ${notes.join(" / ")}` : undefined, data: out, images };
    } catch (err) {
      if (err instanceof GeminiError || err instanceof MediaError) throw new ToolError(err.message);
      throw err;
    }
  },
});
