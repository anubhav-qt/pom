/**
 * A video as Seelie writes it: a composition of timed scenes, each a PariBelle template
 * (templates.ts) filled in, or Seelie's own HTML, CSS and GSAP, or both. This file checks
 * one (validate), lays it out as a HyperFrames project (buildProject: index.html plus a
 * sub-composition per scene, each with its own clock starting at 0), and reads what
 * HyperFrames' check found (summarizeCheck). compose.ts stages the media and runs it.
 */

import { brandCss, checkParams, esc, safeArea, TEMPLATES } from "./templates";

export const MAX_SECONDS = 35;
export const TRANSITIONS = ["cut", "fade", "dissolve", "slide-up", "slide-left", "zoom", "wipe", "flash"] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** How long each way in takes; the scene before stays under it meanwhile. */
const TRANSITION_SECONDS: Record<Transition, number> = { cut: 0, fade: 0.4, dissolve: 0.6, "slide-up": 0.5, "slide-left": 0.5, zoom: 0.45, wipe: 0.5, flash: 0 };

export interface Scene {
  /** Short and unique: "hook", "hero", "price". */
  id: string;
  start: number;
  duration: number;
  /** What this scene does, with a motion verb ("the kurta SLAMS in on the drop"). */
  intent?: string;
  template?: string;
  params?: Record<string, unknown>;
  /** Seelie's own scene, or more on top of a template. Times are the scene's own (0 = its start). */
  html?: string;
  css?: string;
  script?: string;
  /** How it comes in. Default cut. */
  enter?: Transition;
  /** The moment that shows this scene best, in its own seconds (sketches, contact sheets). */
  hero?: number;
}

export interface Layer {
  id: string;
  start: number;
  duration: number;
  html: string;
  css?: string;
  script?: string;
}

export interface Sound {
  ref: string;
  /** When it starts in the video (seconds). */
  at: number;
  /** Seconds into the sound to start from. */
  from?: number;
  duration?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface Composition {
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** The library song under it: song:<id>, from its `from` second (its beat map's time). */
  song?: { ref: string; from?: number; volume?: number; fadeIn?: number; fadeOut?: number };
  sounds?: Sound[];
  /** CSS every scene shares. */
  css?: string;
  scenes: Scene[];
  /** Layers over the scenes for a stretch (a running caption, a logo). */
  overlays?: Layer[];
}

/** The song's beat map in its own seconds (video_assets info gives it). */
export interface BeatMap {
  beats: number[];
  bars: number[];
}

const ID = /^[a-z][a-z0-9-]{0,23}$/;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/* -------------------------------------------------------------------------- */
/* Checking                                                                   */
/* -------------------------------------------------------------------------- */

export interface Verdict {
  /** Must be fixed before anything renders. */
  errors: string[];
  /** Worth fixing (timing off the beat, a scene too short to read). */
  warnings: string[];
}

/** The song's beats in video seconds. */
export function videoBeats(c: Pick<Composition, "song" | "duration">, map: BeatMap | null): BeatMap {
  if (!map || !c.song) return { beats: [], bars: [] };
  const from = c.song.from ?? 0;
  const shift = (ts: number[]) => ts.map((t) => r3(t - from)).filter((t) => t >= 0 && t <= c.duration);
  return { beats: shift(map.beats), bars: shift(map.bars) };
}

export function validate(c: Composition, map: BeatMap | null): Verdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { width, height, fps, duration } = c;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width % 2 || height % 2) errors.push("width and height are even whole pixels, at least 320.");
  if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) errors.push("At most 1080p: the long side up to 1920 px, the short side up to 1080 px (1080x1920 for reels).");
  if (!(fps >= 24 && fps <= 60)) errors.push("fps is between 24 and 60 (30 for reels).");
  if (!(duration > 0 && duration <= MAX_SECONDS)) errors.push(`duration is up to ${MAX_SECONDS} s.`);
  if (!c.scenes?.length) errors.push("A composition needs scenes.");

  const scenes = [...(c.scenes ?? [])].sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const frame = 1 / (fps || 30);
  let at = 0;
  for (const s of scenes) {
    const name = `scene "${s.id}"`;
    if (!ID.test(s.id ?? "")) errors.push(`${name}: an id is lowercase letters, digits and dashes, starting with a letter (up to 24).`);
    if (seen.has(s.id)) errors.push(`${name} appears twice.`);
    seen.add(s.id);
    if (!(s.duration > 0)) errors.push(`${name}: duration must be more than 0.`);
    if (Math.abs(s.start - at) > 0.001) errors.push(`${name} starts at ${s.start} s but the scene before ends at ${r3(at)} s: scenes follow each other with no gaps or overlaps (a transition overlaps for you).`);
    at = s.start + s.duration;
    if (s.duration < 0.6 && !(s.template === "beats")) warnings.push(`${name} lasts ${s.duration} s: too short to read anything; merge it or make it a cut in a beats scene.`);
    if (s.enter && !TRANSITIONS.includes(s.enter)) errors.push(`${name}: enter is one of ${TRANSITIONS.join(", ")}.`);
    if (s.enter && s.enter !== "cut" && TRANSITION_SECONDS[s.enter] > s.duration / 2) warnings.push(`${name}: a ${s.enter} takes ${TRANSITION_SECONDS[s.enter]} s, more than half the scene.`);
    if (s.template) {
      const t = TEMPLATES[s.template];
      if (!t) errors.push(`${name}: there's no template "${s.template}" (${Object.keys(TEMPLATES).join(", ")}).`);
      else errors.push(...checkParams(t, s.params ?? {}).map((e) => `${name}: ${e}`));
    } else if (!s.html?.trim()) {
      errors.push(`${name} needs a template or its own html.`);
    }
    if (s.hero !== undefined && !(s.hero >= 0 && s.hero <= s.duration)) errors.push(`${name}: hero is a moment inside the scene (0 to ${s.duration} s).`);
  }
  if (scenes.length && Math.abs(at - duration) > 0.001) errors.push(`The scenes end at ${r3(at)} s but duration is ${duration} s: the last scene runs to the end.`);
  if (scenes.length && height / width > 1.6) reelRules(scenes, duration, errors, warnings);
  warnings.push(...claimChecks(scenes));
  for (const s of scenes) {
    const small = smallestText(`${s.css ?? ""}\n${s.html ?? ""}`);
    if (small !== null && small < 36) warnings.push(`scene "${s.id}" has text at ${small} px: on a phone that's unreadable; 40 px or more (headlines 80+).`);
  }
  for (const o of c.overlays ?? []) {
    if (!ID.test(o.id ?? "") || seen.has(o.id)) errors.push(`overlay "${o.id}": a unique id (lowercase, digits, dashes).`);
    seen.add(o.id);
    if (!(o.start >= 0 && o.duration > 0 && o.start + o.duration <= duration + 0.001)) errors.push(`overlay "${o.id}" must sit inside the video (0 to ${duration} s).`);
    if (!o.html?.trim()) errors.push(`overlay "${o.id}" needs html.`);
  }

  // The music: cuts land on the beat (within a frame), and a scene change on a bar's downbeat hits hardest.
  if (c.song) {
    if (!/^song:\d+$/.test(c.song.ref)) errors.push("song is a library song (song:<id>).");
    const { beats, bars } = videoBeats(c, map);
    if (map && beats.length) {
      for (const s of scenes.slice(1)) {
        const near = beats.reduce((best, b) => (Math.abs(b - s.start) < Math.abs(best - s.start) ? b : best), beats[0]);
        const off = Math.abs(near - s.start);
        if (off > frame && off < 0.3) warnings.push(`scene "${s.id}" starts ${r3(off)} s off the beat at ${near} s: move the cut onto it.`);
      }
      if (map.beats.length && duration > (map.beats.at(-1) ?? 0) - (c.song.from ?? 0) + 1) warnings.push("The song's beat map ends before the video does; the end may run past the music.");
      if (!bars.length) warnings.push("No bar starts inside the video: check song.from.");
    }
  }
  for (const s of c.sounds ?? []) {
    if (!/^(asset|song):\d+$/.test(s.ref)) errors.push(`sound ${s.ref}: an audio asset (asset:<id>).`);
    if (!(s.at >= 0 && s.at < duration)) errors.push(`sound ${s.ref}: at is inside the video.`);
  }
  return { errors, warnings };
}

/** The photos and clips a scene's template params put on screen (chat:, asset:, video: refs). */
function mediaOf(s: Scene): string[] {
  const t = s.template ? TEMPLATES[s.template] : undefined;
  if (!t) return [];
  const isMedia = (x: unknown): x is string => typeof x === "string" && /^(chat|asset|video):/.test(x);
  return Object.entries(t.params).flatMap(([k, p]) => {
    const v = s.params?.[k];
    if (p.type === "media" || p.type === "background") return isMedia(v) ? [v] : [];
    if (p.type === "medias") return Array.isArray(v) ? v.filter(isMedia) : [];
    return [];
  });
}

/** Whether a scene puts a photo or clip on screen (not the brand's end card). */
export function showsMedia(s: Scene): boolean {
  if (/<(img|video)\b/i.test(s.html ?? "") || /url\(\s*["']?(chat|asset|video):/.test(s.css ?? "")) return true;
  return mediaOf(s).length > 0;
}

/** What makes a reel hold people: the product from the first frame, a quick first cut, the product on screen to the end, no repeats or long holds. */
function reelRules(scenes: Scene[], duration: number, errors: string[], warnings: string[]) {
  const [first] = scenes;
  if (!showsMedia(first)) {
    errors.push(
      `scene "${first.id}" opens the reel without the product: most people decide in the first second whether to stay, and a text card on a plain colour loses them. Open on the product with the words over it (the hook template, or a photo as the background).`,
    );
  } else if (first.template !== "beats" && first.template !== "clip" && !(first.template === "hook" && Array.isArray(first.params?.more) && first.params.more.length) && first.duration > 2.2) {
    warnings.push(`the opening shot "${first.id}" holds ${r3(first.duration)} s: the first cut should land by about 2 s (people decide in the first two seconds whether there's more to see). End it on a beat near 1.5-2 s, or give the hook more photos (more) to cut through on the beat.`);
  }
  // The brand card is the owner's set close (4-5 s); before it, the product stays on screen.
  const flat = scenes.filter((s) => s.template !== "endcard" && !showsMedia(s));
  const flatSeconds = flat.reduce((n, s) => n + s.duration, 0);
  if (flatSeconds > 1.5) {
    warnings.push(`${r3(flatSeconds)} s before the brand card show no product, only words on a colour (${flat.map((s) => `"${s.id}"`).join(", ")}): people swipe away when the product leaves the screen. Put them over a photo of the product (background: a photo ref; the price gets its own solid card).`);
  }
  const ends = scenes.filter((s) => s.template === "endcard");
  if (!ends.length || ends.at(-1) !== scenes.at(-1)) warnings.push(`the video doesn't close on the brand card: the owner wants every video to end on the endcard template, on screen for 4-5 s.`);
  for (const s of scenes) {
    if (s.template === "endcard" && (s.duration < 4 || s.duration > 5)) warnings.push(`the brand card "${s.id}" is on screen ${r3(s.duration)} s: the owner wants it 4-5 s.`);
    else if (s !== first && s.template !== "endcard" && s.template !== "beats" && s.template !== "clip" && s.duration > 3.2) warnings.push(`scene "${s.id}" holds one shot for ${r3(s.duration)} s: cut it in two, or make it a beats montage; on a reel a still frame over ~3 s feels slow.`);
  }
  // The same photo again straight after reads as a repeat; a real close-up of it is a new shot.
  for (let i = 1; i < scenes.length; i++) {
    const a = scenes[i - 1];
    const b = scenes[i];
    if (b.template === "detail" && Number(b.params?.zoom ?? 2.2) >= 1.8) continue;
    const before = new Set(mediaOf(a));
    const shared = [...new Set(mediaOf(b))].filter((r) => before.has(r));
    if (shared.length) warnings.push(`scenes "${a.id}" and "${b.id}" both show ${shared.join(", ")}: the same photo again right after reads as a repeat. Use another photo in "${b.id}", or show that one as a close-up (detail, zoom 1.8+).`);
  }
}

/**
 * Words that often say more than a product's data does ("pure cotton" for cotton, "deep
 * pockets" for side pockets, a place it was made). They may be true; each one is worth
 * checking against the data before it goes on screen.
 */
const CLAIM_WORDS =
  /\b(pure|100\s?%|deep(?! (?:red|maroon|wine|blue|navy|green|teal|pink|purple|brown|yellow|orange|black))|hand[- ]?(?:made|crafted|woven|block(?:ed)?|embroidered|painted|stitched|work)|organic|silk|linen|khadi|chanderi|premium|luxur(?:y|ious)|genuine|authentic|certified|(?:made|designed|crafted|handcrafted) in \w+|ready to ship|free (?:shipping|delivery)|cash on delivery|cod|limited|sold out|only \d+ left|guarantee[d]?)\b/gi;

/** On-screen words worth checking against the product's data, with the line each sits in. */
function claimChecks(scenes: Scene[]): string[] {
  const found = new Map<string, string>();
  for (const s of scenes) {
    const t = s.template ? TEMPLATES[s.template] : undefined;
    const texts = t
      ? Object.entries(t.params).flatMap(([k, p]) => {
          const v = s.params?.[k];
          if (p.type === "text" && typeof v === "string") return [v];
          if (p.type === "list" && Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
          return [];
        })
      : [(s.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()];
    for (const text of texts) {
      for (const m of text.matchAll(CLAIM_WORDS)) {
        const word = m[0].toLowerCase();
        if (!found.has(word)) found.set(word, `"${m[0]}" (in "${text.length > 60 ? `${text.slice(0, 57)}…` : text}")`);
      }
    }
  }
  if (!found.size) return [];
  const list = [...found.values()].join(", ");
  return [`Check these words against the product's data before they go on screen: ${list}. Keep each only if the data says it; otherwise use the data's own words ("cotton", not "pure cotton"; "side pockets", not "deep pockets").`];
}

export interface MediaSize {
  width: number;
  height: number;
}

/** How much larger than itself a photo may be shown before it looks soft on a phone. */
const SOFT_AT = 1.6;

/**
 * Photos (and clips) a template shows much larger than they are: a close-up of a small
 * photo, or a full frame from a thumbnail. Warnings, with what to do instead.
 */
export function softMedia(c: Composition, sizes: Map<string, MediaSize>): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const refs = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
  for (const s of c.scenes) {
    const p = s.params ?? {};
    // Each place a template puts media: the box it fills and the most it scales up inside it.
    const shown: { refs: string[]; w: number; h: number; zoom: number }[] = [];
    const full = (v: unknown, zoom: number) => shown.push({ refs: refs(v), w: c.width, h: c.height, zoom });
    switch (s.template) {
      case "hook":
        full(p.photo, 1.18);
        full(p.more, 1.12);
        break;
      case "hero":
        full(p.photo, 1.18);
        break;
      case "detail":
        full(p.photo, n(p.zoom, 2.2) * 1.09);
        break;
      case "beats":
        full(p.photos, n(p.punch, 1.06) * 1.03);
        break;
      case "split": {
        const side = p.layout === "side" || (p.layout === undefined && c.width >= c.height);
        shown.push({ refs: refs(p.photos), w: side ? c.width / 2 : c.width, h: side ? c.height : c.height / 2, zoom: 1.12 });
        break;
      }
      case "clip":
        full(p.video, 1.06);
        break;
    }
    if (typeof p.background === "string") full(p.background, 1.1);
    if (typeof p.backdrop === "string") full(p.backdrop, 1.1);
    for (const place of shown) {
      for (const ref of place.refs) {
        const size = sizes.get(ref);
        if (!size?.width || !size.height || seen.has(`${s.id}|${ref}`)) continue;
        const factor = Math.max(place.w / size.width, place.h / size.height) * place.zoom;
        if (factor <= SOFT_AT) continue;
        seen.add(`${s.id}|${ref}`);
        const base = factor / place.zoom;
        const zoomCap = Math.floor((SOFT_AT / base / 1.09) * 10) / 10;
        out.push({
          severity: "warning",
          code: "soft_photo",
          scene: s.id,
          at: null,
          what: `${ref} is ${size.width}x${size.height} and shows here at ${Math.round(factor * 10) / 10}x its size, so it will look soft or blocky.`,
          fix:
            s.template === "detail" && zoomCap >= 1.2
              ? `Use zoom ${zoomCap} or less, a larger photo, or photo_edit upscale it first.`
              : "Use a larger photo of the same thing, or photo_edit upscale it first.",
        });
      }
    }
  }
  return out;
}

/** The smallest font size written in a scene's own CSS or inline styles, in canvas px (null when none). */
function smallestText(code: string): number | null {
  let min: number | null = null;
  for (const m of code.matchAll(/font(?:-size)?\s*:[^;{}"]*?(?:calc\(\s*var\(--u\)\s*\*\s*([\d.]+)\s*\)|(?<![\w.-])([\d.]+)px)/g)) {
    const v = Number(m[1] ?? m[2]);
    if (Number.isFinite(v) && v > 0) min = min === null ? v : Math.min(min, v);
  }
  return min;
}

/* -------------------------------------------------------------------------- */
/* Laying it out                                                              */
/* -------------------------------------------------------------------------- */

/** Where media refs appear in a scene's HTML and CSS, so staging can swap them for files. */
const REF_ATTR = /\b(src|poster|href)=(["'])((?:chat|asset|video|brand|song):[\w@]+)\2/g;
const REF_URL = /url\((["']?)((?:chat|asset|video|brand):[\w@]+)\1\)/g;

/** Every media ref a composition uses (scenes, templates, overlays, sounds). */
export function refsIn(c: Composition): string[] {
  const out = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(REF_ATTR)) out.add(m[3]);
    for (const m of s.matchAll(REF_URL)) out.add(m[2]);
  };
  for (const s of c.scenes) {
    scan(s.html);
    scan(s.css);
    const t = s.template ? TEMPLATES[s.template] : null;
    if (t) {
      for (const [k, p] of Object.entries(t.params)) {
        const v = s.params?.[k];
        if ((p.type === "media" || p.type === "background") && typeof v === "string" && /^(chat|asset|video|brand):/.test(v)) out.add(v);
        if (p.type === "medias" && Array.isArray(v)) for (const x of v) if (typeof x === "string") out.add(x);
      }
    }
  }
  for (const o of c.overlays ?? []) {
    scan(o.html);
    scan(o.css);
  }
  if (c.song) out.add(c.song.ref);
  for (const s of c.sounds ?? []) out.add(s.ref);
  return [...out];
}

function swapRefs(s: string, file: (ref: string) => string) {
  return s.replace(REF_ATTR, (_, attr, q, ref) => `${attr}=${q}${file(ref)}${q}`).replace(REF_URL, (_, q, ref) => `url(${q}${file(ref)}${q})`);
}

function transitionScript(enter: Transition | undefined) {
  const T = TRANSITION_SECONDS[enter ?? "cut"];
  switch (enter) {
    case "fade":
    case "dissolve":
      return `tl.fromTo(root, { opacity: 0 }, { opacity: 1, duration: ${T}, ease: "none" }, 0);`;
    case "slide-up":
      return `tl.fromTo(root, { yPercent: 100 }, { yPercent: 0, duration: ${T}, ease: "expo.out" }, 0);`;
    case "slide-left":
      return `tl.fromTo(root, { xPercent: 100 }, { xPercent: 0, duration: ${T}, ease: "expo.out" }, 0);`;
    case "zoom":
      return `tl.fromTo(root, { scale: 1.18, opacity: 0 }, { scale: 1, opacity: 1, duration: ${T}, ease: "power3.out" }, 0);`;
    case "wipe":
      return `tl.fromTo(root, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: ${T}, ease: "power3.inOut" }, 0);`;
    case "flash":
      return `{ const f = document.createElement("div"); f.style.cssText = "position:absolute;inset:0;background:#fff;z-index:99;pointer-events:none"; root.appendChild(f); tl.fromTo(f, { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power2.out" }, 0); }`;
    default:
      return "";
  }
}

export interface ProjectFiles {
  /** Paths inside the project ("index.html", "compositions/sc-hero.html") and their text. */
  files: Record<string, string>;
  /** Scene element ids by scene id. */
  ids: Record<string, string>;
}

/**
 * The HyperFrames project for `c`: index.html (fonts, palette, scene hosts, sound) and one
 * sub-composition per scene and overlay. `file(ref)` is where staging put a ref's media;
 * `fontFaces` the @font-face rules.
 */
export function buildProject(c: Composition, opts: { file: (ref: string) => string; fontFaces: string; map: BeatMap | null }): ProjectFiles {
  const { width: W, height: H } = c;
  const safe = safeArea(W, H);
  const beats = videoBeats(c, opts.map);
  const scenes = [...c.scenes].sort((a, b) => a.start - b.start);
  const files: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const hosts: string[] = [];
  let z = 1;

  const subComposition = (id: string, d: number, html: string, css: string, script: string, local: { beats: number[]; bars: number[] }) => `<div id="${id}" data-composition-id="${id}" data-width="${W}" data-height="${H}">
<style>
#${id} {
  position: absolute; inset: 0; overflow: hidden;
  --u: ${W / 1080}px; --safe-top: ${safe.top}px; --safe-bottom: ${safe.bottom}px; --safe-x: ${safe.x}px;
${css}
}
</style>
${html}
<script>
(() => {
  const root = document.getElementById(${JSON.stringify(id)});
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ paused: true });
  const D = ${r3(d)}, W = ${W}, H = ${H}, U = ${W / 1080}, K = Math.min(1, D / 3.2);
  const beats = ${JSON.stringify(local.beats)}, bars = ${JSON.stringify(local.bars)};
${script}
  window.__timelines = window.__timelines || {};
  window.__timelines[${JSON.stringify(id)}] = tl;
})();
</script>
</div>
`;

  scenes.forEach((s, i) => {
    const id = `sc-${s.id}`;
    ids[s.id] = id;
    const next = scenes[i + 1];
    const overlap = next?.enter ? TRANSITION_SECONDS[next.enter] : 0;
    const local = {
      beats: beats.beats.filter((b) => b >= s.start && b < s.start + s.duration).map((b) => r3(b - s.start)),
      bars: beats.bars.filter((b) => b >= s.start && b < s.start + s.duration).map((b) => r3(b - s.start)),
    };
    const t = s.template ? TEMPLATES[s.template] : null;
    const built = t ? t.build(s.params ?? {}, { id, duration: s.duration, width: W, height: H, beats: local.beats, bars: local.bars }) : { html: "", css: "", script: "" };
    const html = swapRefs([built.html, s.html ?? ""].filter(Boolean).join("\n"), opts.file);
    const css = swapRefs([t ? "" : "background: var(--ivory);", built.css, s.css ?? ""].filter(Boolean).join("\n"), opts.file);
    // Each part in its own block, so a name one declares can't clash with another's.
    const script = [transitionScript(s.enter), built.script && `{\n${built.script}\n}`, s.script && `{ // Seelie's own\n${s.script}\n}`].filter(Boolean).join("\n");
    files[`compositions/${id}.html`] = subComposition(id, s.duration + overlap, html, css, script, local);
    hosts.push(
      `<div id="host-${s.id}" class="clip" style="z-index:${z++}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${r3(s.start)}" data-duration="${r3(s.duration + overlap)}" data-track-index="0"></div>`,
    );
  });

  for (const o of c.overlays ?? []) {
    const id = `ov-${o.id}`;
    ids[o.id] = id;
    files[`compositions/${id}.html`] = subComposition(id, o.duration, swapRefs(o.html, opts.file), swapRefs(o.css ?? "", opts.file), o.script ?? "", { beats: [], bars: [] });
    hosts.push(
      `<div id="host-${o.id}" class="clip" style="z-index:${500 + z++}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${r3(o.start)}" data-duration="${r3(o.duration)}" data-track-index="1"></div>`,
    );
  }

  const audio: string[] = [];
  if (c.song) {
    const s = c.song;
    audio.push(
      `<audio id="song" src="${esc(opts.file(s.ref))}" data-start="0" data-duration="${r3(c.duration)}" data-media-start="${r3(s.from ?? 0)}" data-volume="${s.volume ?? 1}" data-fade-in="${s.fadeIn ?? 0}" data-fade-out="${s.fadeOut ?? Math.min(1.5, c.duration / 6)}" data-track-index="2"></audio>`,
    );
  }
  (c.sounds ?? []).forEach((s, i) =>
    audio.push(
      `<audio id="sound-${i + 1}" src="${esc(opts.file(s.ref))}" data-start="${r3(s.at)}" data-duration="${r3(s.duration ?? c.duration - s.at)}" data-media-start="${r3(s.from ?? 0)}" data-volume="${s.volume ?? 1}" data-fade-in="${s.fadeIn ?? 0}" data-fade-out="${s.fadeOut ?? 0}" data-track-index="${3 + i}"></audio>`,
    ),
  );

  files["index.html"] = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${opts.fontFaces}
${brandCss()}
html, body { margin: 0; background: #000; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ivory); -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
${c.css ?? ""}
</style>
<script src="gsap.min.js"></script>
<script>gsap.config({ nullTargetWarn: false });</script>
</head>
<body>
<div id="root" data-composition-id="root" data-width="${W}" data-height="${H}" data-fps="${c.fps}">
${hosts.join("\n")}
${audio.join("\n")}
</div>
<script>
  window.__timelines = window.__timelines || {};
  window.__timelines.root = gsap.timeline({ paused: true });
</script>
</body>
</html>
`;
  return { files, ids };
}

/* -------------------------------------------------------------------------- */
/* What the check found                                                       */
/* -------------------------------------------------------------------------- */

/** Findings that don't apply to how Seelie builds videos. */
export const IGNORED_CHECKS = ["nested_structure_needs_subcomposition", "nested_media_start_basis_ambiguous", "container_overflow", "root_composition_missing_data_duration"];

/**
 * The bands Instagram covers on a reel, as HyperFrames caption zones (bottom first: the
 * caption and buttons). A zone is looked at only at its `seek` points, fractions of the
 * whole video (not the check's --at times), so they're the same moments as checkTimes.
 */
export function checkZones(c: Composition): string[] {
  if (c.height / c.width <= 1.6) return [];
  const seek = checkTimes(c)
    .map((t) => Math.round((t / c.duration) * 10_000) / 10_000)
    .join(",");
  return ["x0=0;y0=0.65;x1=1;y1=1", "x0=0;y0=0;x1=1;y1=0.14", "x0=0;y0=0;x1=0.06;y1=1", "x0=0.94;y0=0;x1=1;y1=1"].map((z) => `${z};severity=error;seek=${seek}`);
}

/** When two scenes are both on screen on purpose: each way in that isn't a cut. */
export function crossings(c: Composition): [number, number][] {
  return c.scenes.filter((s) => s.enter && TRANSITION_SECONDS[s.enter] > 0).map((s) => [s.start, s.start + TRANSITION_SECONDS[s.enter!]]);
}

/** Codes that are expected while one scene comes in over another. */
export const CROSSING_CODES = ["content_overlap", "text_occluded"];

/** Times worth checking: each scene's start (after its way in), middle and hero moment. */
export function checkTimes(c: Composition): number[] {
  const out = new Set<number>();
  for (const s of c.scenes) {
    out.add(r3(Math.min(s.start + s.duration - 0.05, s.start + Math.max(0.6, TRANSITION_SECONDS[s.enter ?? "cut"] + 0.3))));
    out.add(r3(s.start + s.duration / 2));
    out.add(r3(s.start + (s.hero ?? s.duration * 0.6)));
  }
  return [...out].filter((t) => t >= 0 && t < c.duration).sort((a, b) => a - b);
}

export interface Finding {
  severity: "error" | "warning";
  code: string;
  /** Which scene, by its id, when it can tell. */
  scene: string | null;
  at: number | null;
  what: string;
  fix: string | null;
}

/** HyperFrames' check report, cut down to what Seelie should act on, by scene. */
export function summarizeCheck(report: unknown, c: Composition, ids: Record<string, string>): Finding[] {
  const r = report as Record<string, { findings?: Record<string, unknown>[] } | undefined> | null;
  if (!r) return [];
  const byId = Object.fromEntries(Object.entries(ids).map(([scene, id]) => [id, scene]));
  const sceneAt = (t: number | null) => (t === null ? null : (c.scenes.find((s) => t >= s.start && t < s.start + s.duration)?.id ?? null));
  // Two scenes overlap on purpose while one comes in over the other.
  const windows = crossings(c);
  const inCrossing = (t: number | null) => t !== null && windows.some(([a, b]) => t >= a - 0.01 && t <= b + 0.01);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const section of ["lint", "runtime", "layout", "motion", "contrast"]) {
    for (const f of r[section]?.findings ?? []) {
      const severity = f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : null;
      const code = String(f.code ?? "");
      if (!severity || IGNORED_CHECKS.includes(code)) continue;
      const at = typeof f.time === "number" ? r3(f.time) : null;
      if (CROSSING_CODES.includes(code) && inCrossing(at)) continue;
      const file = typeof f.sourceFile === "string" ? f.sourceFile : "";
      const fromFile = /compositions\/((?:sc|ov)-[a-z0-9-]+)\.html/.exec(file)?.[1];
      const scene = (fromFile && byId[fromFile]) || sceneAt(at);
      const selector = typeof f.selector === "string" ? f.selector : "";
      const text = typeof f.text === "string" ? ` "${f.text.slice(0, 40)}"` : "";
      const key = `${code}|${scene}|${selector}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const extra = code === "contrast_aa_failure" && f.suggestedColor ? ` (try ${String(f.suggestedColor)})` : "";
      out.push({
        severity,
        code,
        scene,
        at,
        what: `${String(f.message ?? code)}${selector ? ` [${selector}]` : ""}${text}${extra}`,
        fix: typeof f.fixHint === "string" ? f.fixHint : null,
      });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? (a.at ?? 0) - (b.at ?? 0) : a.severity === "error" ? -1 : 1));
}

/** Findings as lines for the model. */
export function findingLines(findings: Finding[], max = 25) {
  const lines = findings.slice(0, max).map((f) => `- ${f.severity === "error" ? "ERROR" : "warning"} ${f.code}${f.scene ? ` in "${f.scene}"` : ""}${f.at !== null ? ` at ${f.at} s` : ""}: ${f.what}${f.fix ? ` Fix: ${f.fix}` : ""}`);
  if (findings.length > max) lines.push(`- …and ${findings.length - max} more.`);
  return lines;
}

/** Each scene in a line: when, what, how it comes in. */
export function storyboardLines(c: Composition) {
  return [...c.scenes]
    .sort((a, b) => a.start - b.start)
    .map((s) => `${r3(s.start)}–${r3(s.start + s.duration)} s  ${s.id}${s.template ? ` [${s.template}]` : " [own]"}${s.enter && s.enter !== "cut" ? ` ${s.enter} in` : ""}${s.intent ? `: ${s.intent}` : ""}`);
}
