import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieSettings } from "@/db/schema";

/**
 * Marketplace image specs as presets (seelie_settings `image_specs`). Seelie reads each
 * marketplace's own rules (web_search, fetch_url) and saves what they say with the page
 * it read and the day it checked, so `fit` makes exactly that and nothing is guessed.
 */

const KEY = "image_specs";

export interface ImageSpec {
  /** e.g. "amazon-main". */
  name: string;
  marketplace: string;
  /** What it's for: "main image", "other images", "Instagram post", ... */
  use: string;
  /** The size to make. */
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
  /** The file must stay under this. */
  maxBytes?: number;
  /** "white": pure white (RGB 255) behind the product; "any" otherwise. */
  background: "white" | "any";
  /** How much of the frame the product fills on white (0.85 = 85%). */
  fill?: number;
  /** Anything else the rules say (no text, no props, a minimum size for zoom, ...). */
  notes?: string;
  /** The official page the rules came from, and the day it was read. */
  source: string;
  checkedOn: string;
  savedBy?: number;
}

export async function listSpecs(): Promise<ImageSpec[]> {
  const [row] = await db.select({ value: seelieSettings.value }).from(seelieSettings).where(eq(seelieSettings.key, KEY)).limit(1);
  return ((row?.value as { presets?: ImageSpec[] } | undefined)?.presets ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSpec(name: string): Promise<ImageSpec | null> {
  return (await listSpecs()).find((s) => s.name === name.trim().toLowerCase()) ?? null;
}

async function write(presets: ImageSpec[], userId: number) {
  const value = { presets };
  await db
    .insert(seelieSettings)
    .values({ key: KEY, value, updatedBy: userId })
    .onConflictDoUpdate({ target: seelieSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
}

export async function saveSpec(spec: ImageSpec, userId: number): Promise<ImageSpec> {
  const clean = { ...spec, name: spec.name.trim().toLowerCase(), savedBy: userId };
  const rest = (await listSpecs()).filter((s) => s.name !== clean.name);
  await write([...rest, clean], userId);
  return clean;
}

export async function removeSpec(name: string, userId: number): Promise<boolean> {
  const all = await listSpecs();
  const rest = all.filter((s) => s.name !== name.trim().toLowerCase());
  if (rest.length === all.length) return false;
  await write(rest, userId);
  return true;
}
