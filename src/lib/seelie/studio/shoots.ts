import "server-only";

import { desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieGarments, seeliePersonas, seelieShoots } from "@/db/schema";

import { removeAsset } from "../media/files";
import type { GarmentSpec, LookBrief, PromptRef, RefRole } from "./prompts";

/**
 * Photoshoots as data: the garments Seelie has studied (their photos with the view each
 * shows, and the spec it wrote), the personas (recurring synthetic models), and each
 * shoot's looks with every attempt, its check, its verdict and the one chosen.
 */

/* -------------------------------------------------------------------------- */
/* Garments                                                                   */
/* -------------------------------------------------------------------------- */

export interface GarmentPhoto {
  /** asset:<id> or chat:<n>. */
  ref: string;
  /** What it shows: front, back, side, detail, worn, mirror selfie, flat, ... */
  view: string;
  note?: string;
  /** Where it was fetched from. */
  url?: string;
}

export interface Garment {
  key: string;
  name: string;
  spec: GarmentSpec | null;
  photos: GarmentPhoto[];
  updatedAt: string;
}

export const garmentKey = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export async function getGarment(key: string): Promise<Garment | null> {
  const [row] = await db.select().from(seelieGarments).where(eq(seelieGarments.key, garmentKey(key))).limit(1);
  if (!row) return null;
  return { key: row.key, name: row.name, spec: (row.spec as GarmentSpec | null) ?? null, photos: (row.photos as GarmentPhoto[]) ?? [], updatedAt: row.updatedAt.toISOString() };
}

export async function saveGarment(g: { key: string; name: string; spec?: GarmentSpec | null; photos: GarmentPhoto[] }, userId: number | null): Promise<Garment> {
  const key = garmentKey(g.key);
  const values = { name: g.name, photos: g.photos, ...(g.spec !== undefined ? { spec: g.spec } : {}), updatedBy: userId, updatedAt: new Date() };
  const [row] = await db
    .insert(seelieGarments)
    .values({ key, ...values })
    .onConflictDoUpdate({ target: seelieGarments.key, set: values })
    .returning();
  return { key: row.key, name: row.name, spec: (row.spec as GarmentSpec | null) ?? null, photos: row.photos as GarmentPhoto[], updatedAt: row.updatedAt.toISOString() };
}

export const hasBack = (g: Pick<Garment, "photos">) => g.photos.some((p) => /\bback\b/i.test(p.view));

/* -------------------------------------------------------------------------- */
/* Personas                                                                   */
/* -------------------------------------------------------------------------- */

export interface Persona {
  id: number;
  name: string;
  description: string;
  /** Image asset ids: the face first, then full length. Up to 4. */
  refs: number[];
  notes: string | null;
}

const personaOf = (row: typeof seeliePersonas.$inferSelect): Persona => ({
  id: row.id,
  name: row.name,
  description: row.description,
  refs: (row.refs as number[]) ?? [],
  notes: row.notes,
});

export async function listPersonas(): Promise<Persona[]> {
  return (await db.select().from(seeliePersonas).orderBy(desc(seeliePersonas.updatedAt))).map(personaOf);
}

export async function getPersona(id: number): Promise<Persona | null> {
  const [row] = await db.select().from(seeliePersonas).where(eq(seeliePersonas.id, id)).limit(1);
  return row ? personaOf(row) : null;
}

export async function savePersona(p: Omit<Persona, "id"> & { id?: number }): Promise<Persona> {
  const values = { name: p.name, description: p.description, refs: p.refs, notes: p.notes, updatedAt: new Date() };
  if (p.id) {
    const [row] = await db.update(seeliePersonas).set(values).where(eq(seeliePersonas.id, p.id)).returning();
    if (row) return personaOf(row);
  }
  const [row] = await db.insert(seeliePersonas).values(values).returning();
  return personaOf(row);
}

export async function removePersona(id: number) {
  const rows = await db.delete(seeliePersonas).where(eq(seeliePersonas.id, id)).returning({ id: seeliePersonas.id });
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Shoots                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * planned: ready to shoot · shooting: an image call is out · shot: has attempts to judge ·
 * done: one is chosen · waiting: the image cap ran out (waits for the owner's "continue") ·
 * failed: the last call errored (shooting it again retries)
 */
export type LookStatus = "planned" | "shooting" | "shot" | "done" | "waiting" | "failed";

/** An image of the look's own besides the product photos: a detail close-up, the recast's source, a mood. */
export interface LookRef {
  ref: string;
  role: Extract<RefRole, "detail" | "source" | "style">;
  note?: string;
}

export interface Attempt {
  ref: string;
  at: string;
  size: string;
  aspect: string;
  ms: number;
  prompt: string;
  /** The templates' version (prompts.templateVersion). */
  templates: string;
  /** The images sent, in order, with their roles. */
  refs: { ref: string; role: RefRole }[];
  /** The automatic colour check against our main photo. */
  colours?: string;
  mainDeltaE?: number | null;
  /** Seelie's verdict once it has judged the compare sheet. */
  verdict?: string;
  /** What the image model said alongside the picture, if anything. */
  said?: string;
  /** Not chosen, and its file was removed after KEEP_UNCHOSEN_DAYS. */
  pruned?: boolean;
}

export interface ShootLook {
  id: string;
  brief: LookBrief;
  refs: LookRef[];
  /** Use the set's anchor (its first chosen worn look) for place, light and the model. */
  anchor: boolean;
  status: LookStatus;
  attempts: Attempt[];
  chosen: string | null;
  verdict: string | null;
  error?: string | null;
}

export type ShootStatus = "planned" | "shooting" | "waiting" | "done";

export interface Shoot {
  id: number;
  chatId: string | null;
  userId: number | null;
  title: string;
  garmentKey: string | null;
  personaId: number | null;
  brief: string | null;
  looks: ShootLook[];
  status: ShootStatus;
  liked: boolean | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const shootOf = (row: typeof seelieShoots.$inferSelect): Shoot => ({
  id: row.id,
  chatId: row.chatId,
  userId: row.userId,
  title: row.title,
  garmentKey: row.garmentKey,
  personaId: row.personaId,
  brief: row.brief,
  looks: (row.looks as ShootLook[]) ?? [],
  status: row.status as ShootStatus,
  liked: row.liked,
  notes: row.notes,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function getShoot(id: number): Promise<Shoot | null> {
  const [row] = await db.select().from(seelieShoots).where(eq(seelieShoots.id, id)).limit(1);
  return row ? shootOf(row) : null;
}

export async function recentShoots(limit = 20): Promise<Shoot[]> {
  return (await db.select().from(seelieShoots).orderBy(desc(seelieShoots.updatedAt)).limit(limit)).map(shootOf);
}

/** Shoots with looks waiting for the image budget. */
export async function waitingShoots(): Promise<Shoot[]> {
  return (await db.select().from(seelieShoots).where(eq(seelieShoots.status, "waiting")).orderBy(desc(seelieShoots.updatedAt))).map(shootOf);
}

/** The shoot's status from its looks. */
export function shootStatus(looks: ShootLook[]): ShootStatus {
  if (looks.some((l) => l.status === "shooting")) return "shooting";
  if (looks.some((l) => l.status === "waiting")) return "waiting";
  if (looks.length && looks.every((l) => l.status === "done")) return "done";
  return "planned";
}

export async function createShoot(s: Pick<Shoot, "chatId" | "userId" | "title" | "garmentKey" | "personaId" | "brief" | "looks">): Promise<Shoot> {
  const [row] = await db
    .insert(seelieShoots)
    .values({ ...s, status: shootStatus(s.looks) })
    .returning();
  return shootOf(row);
}

export async function updateShoot(id: number, set: Partial<Pick<Shoot, "title" | "personaId" | "brief" | "looks" | "liked" | "notes">>): Promise<Shoot> {
  const [row] = await db
    .update(seelieShoots)
    .set({ ...set, ...(set.looks ? { status: shootStatus(set.looks) } : {}), updatedAt: new Date() })
    .where(eq(seelieShoots.id, id))
    .returning();
  if (!row) throw new Error(`There's no shoot ${id}.`);
  return shootOf(row);
}

/** Every image a shoot's looks have made (chosen or not), for listing and pruning. */
export function attemptRefs(s: Pick<Shoot, "looks">) {
  return s.looks.flatMap((l) => l.attempts.map((a) => a.ref));
}

/** Shoots that used a persona (for the persona list). */
export async function shootsWithPersonas(ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const rows = await db
    .select({ id: seelieShoots.personaId, n: sql<number>`count(*)::int` })
    .from(seelieShoots)
    .where(inArray(seelieShoots.personaId, ids))
    .groupBy(seelieShoots.personaId);
  return new Map(rows.map((r) => [r.id!, Number(r.n)]));
}

/* -------------------------------------------------------------------------- */
/* What a look sends                                                          */
/* -------------------------------------------------------------------------- */

/** Google: up to 10 object images and 4 of a character for this model; 14 in all. */
export const MAX_OBJECT_REFS = 10;
export const MAX_PERSONA_REFS = 4;
export const MAX_REFS = 14;

const VIEW_ORDER: [RegExp, number][] = [
  [/\bfront\b/i, 0],
  [/worn|selfie|model|on[- ]body/i, 1],
  [/flat|hanger|ghost/i, 2],
  [/\bback\b/i, 3],
  [/side|three[- ]quarter/i, 4],
  [/detail|close/i, 5],
];
const viewRank = (view: string) => VIEW_ORDER.find(([re]) => re.test(view))?.[1] ?? 6;

/** A look's model wears the garment (so a persona and an anchor apply). */
export const isWorn = (b: Pick<LookBrief, "kind" | "change">) => b.kind === "on-model" || (b.kind === "recast" && (b.change === "model" || b.change === "to-on-model"));

/**
 * The images a look sends, in the fixed order: the recast's source; our product photos
 * (front first; close-ups first for a detail look; never past 10 object images with the
 * look's own detail crops); the persona (up to 4); the set's anchor; then mood images.
 */
export function lookRefs(look: ShootLook, garment: Garment, persona: Persona | null, anchor: string | null): PromptRef[] {
  const out: PromptRef[] = [];
  const source = look.refs.find((r) => r.role === "source");
  if (source) out.push({ ref: source.ref, role: "source", note: source.note });

  // At least one product photo; the look's detail crops take the rest of the room first.
  const objects = MAX_OBJECT_REFS - (source ? 1 : 0);
  const details = look.refs.filter((r) => r.role === "detail").slice(0, objects - 1);
  const detailLook = look.brief.kind === "detail";
  const photos = [...garment.photos].sort((a, b) => {
    const ra = detailLook && /detail|close/i.test(a.view) ? -1 : viewRank(a.view);
    const rb = detailLook && /detail|close/i.test(b.view) ? -1 : viewRank(b.view);
    return ra - rb;
  });
  for (const p of photos.slice(0, objects - details.length)) out.push({ ref: p.ref, role: "product", view: p.view, note: p.note });
  for (const d of details) out.push({ ref: d.ref, role: "detail", note: d.note });

  if (persona && isWorn(look.brief)) for (const id of persona.refs.slice(0, MAX_PERSONA_REFS)) out.push({ ref: `asset:${id}`, role: "persona" });
  if (anchor && look.anchor && isWorn(look.brief)) out.push({ ref: anchor, role: "anchor" });
  for (const s of look.refs.filter((r) => r.role === "style")) out.push({ ref: s.ref, role: "style", note: s.note });
  return out.slice(0, MAX_REFS);
}

/** The set's anchor: the chosen picture of its first chosen worn look (not the look itself). */
export function anchorOf(s: Pick<Shoot, "looks">, lookId: string): string | null {
  const first = s.looks.find((l) => l.id !== lookId && l.chosen && isWorn(l.brief));
  return first?.chosen ?? null;
}

/* -------------------------------------------------------------------------- */
/* Pruning                                                                    */
/* -------------------------------------------------------------------------- */

/** Attempts no look chose are kept this long, then their files go (chosen ones stay for good). */
export const KEEP_UNCHOSEN_DAYS = 30;

/** Remove the files of unchosen attempts older than KEEP_UNCHOSEN_DAYS; how many went. */
export async function pruneAttempts(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - KEEP_UNCHOSEN_DAYS * 86400_000);
  const rows = await db
    .select()
    .from(seelieShoots)
    .where(
      sql`exists (select 1 from jsonb_array_elements(${seelieShoots.looks}) l, jsonb_array_elements(l->'attempts') a
        where (a->>'at')::timestamptz < ${cutoff.toISOString()}::timestamptz and coalesce((a->>'pruned')::boolean, false) = false
          and (a->>'ref') is distinct from (l->>'chosen'))`,
    );
  let gone = 0;
  for (const row of rows) {
    const looks = (row.looks as ShootLook[]) ?? [];
    for (const look of looks) {
      for (const a of look.attempts) {
        if (a.pruned || a.ref === look.chosen || new Date(a.at) >= cutoff) continue;
        if (a.ref.startsWith("asset:")) await removeAsset(Number(a.ref.slice(6)));
        a.pruned = true;
        gone++;
      }
    }
    await db.update(seelieShoots).set({ looks }).where(eq(seelieShoots.id, row.id));
  }
  return gone;
}
