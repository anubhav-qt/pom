import "server-only";

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import nunjucks from "nunjucks";

/**
 * Photoshoot prompts: Seelie fills the slots (what the shot is, where, the light, the
 * owner's words) and the Nunjucks templates in templates/ (Jinja2 syntax) turn them into
 * the prose Google's image models follow best. The templates are files so the prompts
 * can be tuned without touching code; each image records the templates' version.
 */

const DIR = path.join(process.cwd(), "src/lib/seelie/studio/templates");

export const LOOK_KINDS = ["on-model", "flat-lay", "ghost", "detail", "recast"] as const;
export type LookKind = (typeof LOOK_KINDS)[number];
export const RECAST_CHANGES = ["model", "remove-phone", "to-on-model", "to-flat-lay", "setting"] as const;
export type RecastChange = (typeof RECAST_CHANGES)[number];
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export const SHOOT_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"] as const;

/** What Seelie writes once it has looked at every photo of a garment. */
export interface GarmentSpec {
  /** A few sentences: the pieces, fabric, colours, every motif with its size and where it sits, neckline, sleeves, length, flare, dupatta, bottoms. */
  summary: string;
  /** The details that must survive, one per item ("gold zari chevron band at each cuff"). */
  keep: string[];
  /** Its colours as they look in good daylight ("deep maroon", "antique gold"). */
  colours: string[];
  hasDupatta: boolean;
}

export type RefRole = "product" | "detail" | "persona" | "anchor" | "style" | "source";

export interface PromptRef {
  ref: string;
  role: RefRole;
  /** product: the view ("front", "back", "mirror selfie", ...). */
  view?: string;
  note?: string;
}

export interface LookBrief {
  id: string;
  kind: LookKind;
  change?: RecastChange;
  framing?: string;
  fullLength?: boolean;
  angle?: string;
  pose?: string;
  expression?: string;
  detail?: string;
  setting?: string;
  light?: string;
  camera?: string;
  styling?: string;
  mood?: string;
  aspect?: (typeof SHOOT_ASPECTS)[number];
  size?: (typeof IMAGE_SIZES)[number];
  thinking?: "minimal" | "high";
  /** The owner's own words for this look, verbatim. */
  direction?: string;
  /** Fixes for a retake, from the last attempt's check. */
  corrections?: string[];
  brand?: boolean;
}

export class PromptError extends Error {}

const DEFAULT_MODEL = "a graceful Indian woman in her mid-twenties with a warm, natural look and long dark hair";

const DEFAULTS: Record<LookKind, Partial<LookBrief>> = {
  "on-model": {
    framing: "full-length shot",
    fullLength: true,
    setting: "a warm-neutral studio with a seamless backdrop in soft greige",
    light: "soft, directional daylight from one side, with gentle shadows that show the fabric's drape",
    camera: "an 85mm lens at f/2.8, from chest height",
  },
  "flat-lay": {
    setting: "a smooth warm-white linen surface",
    light: "soft, diffused overhead daylight",
    camera: "a 50mm lens at f/8, directly overhead",
  },
  ghost: {
    setting: "pure white seamless (RGB 255, 255, 255) with a faint natural shadow below the hem",
    light: "soft, even studio light from both sides",
    camera: "a 70mm lens at f/8, at chest height",
  },
  detail: {
    framing: "macro close-up",
    light: "soft side light",
    camera: "a 100mm macro lens at f/5.6",
  },
  recast: {
    framing: "full-length shot",
    fullLength: true,
  },
};

let env: nunjucks.Environment | null = null;
let version: string | null = null;

function environment() {
  env ??= new nunjucks.Environment(new nunjucks.FileSystemLoader(DIR, { noCache: process.env.NODE_ENV !== "production" }), {
    autoescape: false,
  });
  return env;
}

/** A short hash of every template, so an image's feedback can be tied to the prompts that made it. */
export function templateVersion(): string {
  if (version && process.env.NODE_ENV === "production") return version;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".njk")) files.push(full);
    }
  };
  walk(DIR);
  const hash = createHash("sha256");
  for (const f of files.sort()) hash.update(path.relative(DIR, f)).update(readFileSync(f));
  version = hash.digest("hex").slice(0, 12);
  return version;
}

/** Paragraphs are split by blank lines in the templates; a single newline is a space. */
function tidy(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export interface RenderInput {
  look: LookBrief;
  garment: { name: string; spec: GarmentSpec; hasBack: boolean };
  /** The persona's description, when the look has a model. */
  model?: string | null;
  /** The images in the order they're sent, with their roles. */
  refs: PromptRef[];
}

/** The prompt for one look. Missing pieces the look needs are errors, not guesses. */
export function renderLook(input: RenderInput): string {
  const { look, garment } = input;
  const d = DEFAULTS[look.kind];
  if (!garment.spec?.summary?.trim()) throw new PromptError(`${garment.name} has no garment spec yet: study its photos and save one first (photoshoot spec).`);
  if (look.kind === "detail" && !look.detail?.trim()) throw new PromptError(`Look ${look.id}: a detail look names the detail (detail: "the yoke embroidery").`);
  if (look.kind === "recast" && !look.change) throw new PromptError(`Look ${look.id}: a recast names its change (${RECAST_CHANGES.join(", ")}).`);
  if (look.kind === "recast" && !input.refs.some((r) => r.role === "source")) throw new PromptError(`Look ${look.id}: a recast needs the source photograph (source).`);
  if (look.kind === "recast" && look.change === "setting" && !look.setting?.trim()) throw new PromptError(`Look ${look.id}: which new setting?`);
  if (!input.refs.some((r) => r.role === "product" || r.role === "source")) throw new PromptError("A shoot needs the product's own photographs.");
  const worn = look.kind === "on-model" || (look.kind === "recast" && look.change !== "to-flat-lay");

  const slots = {
    kind: look.kind,
    change: look.change ?? null,
    worn,
    refs: input.refs.map((r) => ({ role: r.role, view: r.view ?? null, note: r.note?.replace(/[.\s]+$/, "") ?? null })),
    shot: {
      framing: look.framing ?? d.framing ?? "photograph",
      fullLength: look.fullLength ?? (look.framing ? /full[- ]length|head to toe/i.test(look.framing) : (d.fullLength ?? false)),
      angle: look.angle ?? null,
      pose: look.pose?.replace(/[.\s]+$/, "") ?? null,
      expression: look.expression ?? null,
      detail: look.detail ?? null,
    },
    model: input.model?.trim() || DEFAULT_MODEL,
    setting: look.setting ?? d.setting ?? null,
    light: look.light ?? d.light ?? null,
    camera: look.camera ?? d.camera ?? null,
    styling: look.styling?.replace(/[.\s]+$/, "") ?? null,
    mood: look.mood ?? null,
    aspect: look.aspect ?? "3:4",
    brand: look.brand !== false,
    direction: look.direction?.trim().replace(/"/g, "'") ?? null,
    corrections: (look.corrections ?? []).map((c) => c.trim().replace(/[.\s]+$/, "")).filter(Boolean),
    garment: {
      name: garment.name,
      spec: garment.spec.summary.trim(),
      keep: garment.spec.keep.map((k) => k.trim().replace(/[.;\s]+$/, "")).filter(Boolean),
      colours: garment.spec.colours.map((c) => c.trim()).filter(Boolean),
      hasDupatta: garment.spec.hasDupatta,
      hasBack: garment.hasBack,
    },
  };
  return tidy(environment().render(`${look.kind}.njk`, slots));
}

/** The prompt for a new persona's model sheet (face and full length side by side). */
export function renderPersona(input: { description: string; direction?: string | null; aspect?: string }): string {
  if (!input.description.trim()) throw new PromptError("A persona needs a description of the woman (age, look, hair, build).");
  return tidy(
    environment().render("persona.njk", {
      model: input.description.trim().replace(/[.\s]+$/, ""),
      direction: input.direction?.trim().replace(/"/g, "'") || null,
      aspect: input.aspect ?? "4:3",
    }),
  );
}
