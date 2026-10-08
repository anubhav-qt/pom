/**
 * PariBelle's video templates: scenes Seelie fills in rather than drawing from nothing.
 * Each builds HTML, CSS and a GSAP script for one scene of a composition (composition.ts),
 * in the brand's look (paribelle.in's fonts and palette) and with the motion rules the
 * prompt teaches built in: entrances on .out eases and staggered, nothing starts at 0,
 * every photo moves, text stays in the safe area, a scene builds, breathes, then holds.
 *
 * Sizes are written for a 1080-wide canvas and scale with --u (canvas width / 1080).
 * Scripts get: tl (the scene's paused timeline, 0 = the scene's start), q (selector inside
 * the scene), root, D (seconds), W, H, U (px per unit), K (entrance speed: 1, less in a
 * short scene), beats and bars (the song's, in scene seconds).
 */

export interface SceneCtx {
  /** The scene's element id ("sc-hero"). */
  id: string;
  duration: number;
  width: number;
  height: number;
  /** The song's beats and bars that fall inside the scene, in scene seconds. */
  beats: number[];
  bars: number[];
}

export interface Built {
  html: string;
  css: string;
  script: string;
}

type ParamType = "text" | "media" | "medias" | "number" | "color" | "background" | "choice" | "list" | "numbers" | "boolean";

export interface Param {
  type: ParamType;
  doc: string;
  required?: boolean;
  /** Longest text, most items, or highest number. */
  max?: number;
  min?: number;
  choices?: readonly string[];
}

export interface Template {
  name: string;
  summary: string;
  params: Record<string, Param>;
  build(p: Record<string, unknown>, ctx: SceneCtx): Built;
}

/* -------------------------------------------------------------------------- */
/* The brand                                                                  */
/* -------------------------------------------------------------------------- */

/** paribelle.in's palette (marketplace-web src/styles/tokens.css), plus a gold dark enough for text on light. */
export const PALETTE: Record<string, string> = {
  ivory: "hsl(350 44% 98%)",
  shell: "hsl(350 44% 96%)",
  "blush-wash": "hsl(350 52% 94%)",
  blush: "hsl(349 56% 89%)",
  linen: "hsl(348 24% 90%)",
  rose: "hsl(349 48% 70%)",
  "rose-deep": "hsl(348 42% 52%)",
  "rose-ink": "hsl(344 38% 36%)",
  gold: "hsl(38 38% 59%)",
  "gold-soft": "hsl(40 45% 80%)",
  "gold-ink": "hsl(38 45% 34%)",
  ink: "hsl(340 18% 18%)",
  "ink-muted": "hsl(340 10% 42%)",
  wine: "hsl(345 33% 30%)",
  "wine-deep": "hsl(345 40% 19%)",
  white: "#ffffff",
  black: "#000000",
};

/** Backgrounds light text goes on. */
const DARK = new Set(["rose-deep", "rose-ink", "ink", "wine", "wine-deep", "black"]);

export const FONTS = { display: "Cormorant Garamond", text: "Jost", logo: "Italiana" };

/** The root CSS every composition starts from: palette and fonts as variables. */
export function brandCss() {
  return [
    ":root {",
    ...Object.entries(PALETTE).map(([k, v]) => `  --${k}: ${v};`),
    `  --font-display: "${FONTS.display}", "Noto Serif", serif;`,
    `  --font-text: "${FONTS.text}", "Noto Sans", sans-serif;`,
    `  --font-logo: "${FONTS.logo}", "${FONTS.display}", serif;`,
    "}",
  ].join("\n");
}

/**
 * Where text may go on this canvas: a reel's top 14%, bottom 35% and 6% each side belong to
 * Instagram's buttons and captions (the check's bands, composition.ts); text keeps a little
 * inside them, since glyphs overhang their boxes.
 */
export function safeArea(width: number, height: number) {
  const portrait = height / width > 1.6;
  return portrait
    ? { top: Math.round(height * 0.15), bottom: Math.round(height * 0.36), x: Math.round(width * 0.07) }
    : { top: Math.round(height * 0.05), bottom: Math.round(height * 0.05), x: Math.round(width * 0.05) };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const u = (n: number) => `calc(var(--u) * ${n})`;

export function esc(s: string) {
  // A separator stays with the word before it, so a wrapped line never starts with "· Sheer Dupatta".
  return s.replace(/ ([·•|–—+])(?= )/g, "\u00a0$1").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Words in masks, so they can rise into view one by one. */
const words = (s: string) =>
  esc(s)
    .split(/[ \t\r\n]+/)
    .filter(Boolean)
    .map((w) => `<span class="w" data-layout-allow-overflow><span data-layout-allow-overflow>${w}</span></span>`)
    .join(" ");

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** A colour param: a palette name or a CSS colour. */
export function colour(v: unknown, fallback: string) {
  const s = str(v) || fallback;
  return PALETTE[s] ? `var(--${s})` : s;
}

const isMedia = (v: string) => /^(chat|asset|video|brand):/.test(v);

/** A background param: a palette name, a CSS colour, or a photo (dimmed so text reads on it). */
/** `veil`: how much a photo is dimmed (less when the words sit on their own card). */
function background(v: unknown, fallback: string, veil = 1): { html: string; css: string; dark: boolean; photo: boolean } {
  const s = str(v) || fallback;
  if (isMedia(s)) {
    return {
      html: `<img class="bg" data-layout-allow-overflow src="${esc(s)}" alt=""><div class="veil"></div>`,
      css: `.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.veil { position: absolute; inset: 0; background: linear-gradient(180deg, hsl(345 40% 12% / ${0.55 * veil}), hsl(345 40% 12% / ${0.35 * veil}) 45%, hsl(345 40% 12% / ${0.7 * veil})); }`,
      dark: true,
      photo: true,
    };
  }
  const dark = DARK.has(s) || /^#(0|1|2|3)/.test(s);
  const c = colour(s, fallback);
  return {
    html: `<div class="bg" data-layout-allow-overflow></div>`,
    css: `.bg { position: absolute; inset: -6%; background: radial-gradient(120% 80% at 30% 20%, color-mix(in srgb, ${c} 82%, white), ${c} 55%, color-mix(in srgb, ${c} 88%, black)); }`,
    dark,
    photo: false,
  };
}

/** Text colours for a light or dark ground. */
const tone = (dark: boolean) =>
  dark
    ? { head: "var(--ivory)", body: "color-mix(in srgb, var(--ivory) 86%, transparent)", accent: "var(--gold-soft)", rule: "var(--gold)" }
    : { head: "var(--wine-deep)", body: "var(--ink-muted)", accent: "var(--gold-ink)", rule: "var(--gold)" };

/** A headline's size by length, so long ones don't overflow. */
const headSize = (text: string, big = 1) => {
  const n = text.length;
  return Math.round((n <= 10 ? 172 : n <= 18 ? 140 : n <= 30 ? 116 : n <= 44 ? 98 : 88) * big);
};

/** The safe text box (between the reel's covered bands). */
const SAFE_BOX = `position: absolute; left: var(--safe-x); right: var(--safe-x); top: var(--safe-top); bottom: var(--safe-bottom);`;

/** Text resting on the bottom of the safe area, with room for an entrance that rises into place. */
const ABOVE_BOTTOM = `bottom: calc(var(--safe-bottom) + ${u(48)})`;

/** A photo's move over the whole scene: big enough to read as motion on a phone. */
function moveScript(sel: string, move: string) {
  const moves: Record<string, string> = {
    "push-in": `{ scale: 1.03 }, { scale: 1.18`,
    "pull-out": `{ scale: 1.2 }, { scale: 1.03`,
    "pan-up": `{ scale: 1.16, yPercent: 4 }, { scale: 1.16, yPercent: -4`,
    "pan-down": `{ scale: 1.16, yPercent: -4 }, { scale: 1.16, yPercent: 4`,
    "pan-left": `{ scale: 1.16, xPercent: 4 }, { scale: 1.16, xPercent: -4`,
    "pan-right": `{ scale: 1.16, xPercent: -4 }, { scale: 1.16, xPercent: 4`,
    drift: `{ scale: 1.06, rotation: -0.8 }, { scale: 1.12, rotation: 0.8`,
  };
  return `tl.fromTo(q("${sel}"), ${moves[move] ?? moves["push-in"]}, duration: D, ease: "sine.inOut" }, 0);`;
}

/**
 * Words over a photo: on solid wine boxes, one per line, so they read on any photo (white
 * studio backdrops included) without greying the picture under a scrim.
 */
const BOXED = (sel: string) => `${sel} { display: inline; padding: .08em .3em; line-height: 1.32; background: hsl(345 40% 16% / .9); box-decoration-break: clone; -webkit-box-decoration-break: clone; }`;

const MOVES = ["push-in", "pull-out", "pan-up", "pan-down", "pan-left", "pan-right", "drift"] as const;

/* -------------------------------------------------------------------------- */
/* The templates                                                              */
/* -------------------------------------------------------------------------- */

const title: Template = {
  name: "title",
  summary: "A big headline over a photo (background: a photo ref) or a colour: a collection name, a section, a closing line; a reel opens with hook instead. Kicker, headline rising word by word, a gold rule drawing, a line under it.",
  params: {
    headline: { type: "text", required: true, max: 60, doc: "The words; under 6 words hits hardest." },
    kicker: { type: "text", max: 40, doc: "Small caps line above (\"New drop\", \"Festive edit\")." },
    sub: { type: "text", max: 90, doc: "A line under the headline." },
    background: { type: "background", doc: "Palette name (ivory, shell, blush, rose, wine, wine-deep, ink…), CSS colour, or a photo (dimmed). Default ivory." },
    align: { type: "choice", choices: ["center", "left"], doc: "Default center." },
  },
  build(p) {
    const bg = background(p.background, "ivory");
    const t = tone(bg.dark);
    const head = str(p.headline);
    const align = p.align === "left" ? "left" : "center";
    return {
      html: `${bg.html}
<div class="block">
  ${str(p.kicker) ? `<div class="kicker">${esc(str(p.kicker))}</div>` : ""}
  <h1 class="headline">${words(head)}</h1>
  <div class="rule"></div>
  ${str(p.sub) ? `<p class="sub">${esc(str(p.sub))}</p>` : ""}
</div>`,
      css: `${bg.css}
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: center; align-items: ${align === "center" ? "center" : "flex-start"}; text-align: ${align}; }
.kicker { font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: ${t.accent}; margin-bottom: ${u(34)}; }
.headline { margin: 0; font: 500 ${u(headSize(head))}/1.02 var(--font-display); letter-spacing: -0.012em; color: ${t.head}; text-wrap: balance; }
.headline .w { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: .08em; }
.headline .w > span { display: inline-block; }
.rule { width: ${u(150)}; height: ${u(2)}; background: ${t.rule}; margin: ${u(40)} 0 ${u(30)}; transform-origin: ${align === "center" ? "50%" : "0%"} 50%; }
.sub { margin: 0; max-width: ${u(860)}; font: 400 ${u(44)}/1.35 var(--font-text); color: ${t.body}; }`,
      // Over a photo, the owner wants the card fully opaque for its last 2-3 s: the photo fades out under solid wine.
      script: `${bg.photo ? `tl.fromTo(q(".bg"), { scale: 1.1 }, { scale: 1.02, duration: D, ease: "sine.out" }, 0);
const solid = Math.min(3, Math.max(2, D - 1.5));
tl.to(q(".solid"), { opacity: 1, duration: 0.5, ease: "sine.inOut" }, Math.max(0, D - solid - 0.5));` : `tl.fromTo(q(".bg"), { xPercent: -2, yPercent: -2 }, { xPercent: 2, yPercent: 1, duration: D, ease: "sine.inOut" }, 0);`}
tl.from(q(".kicker"), { opacity: 0, y: 18 * U, duration: 0.9 * K, ease: "power3.out" }, 0.12 * K);
tl.from(q(".headline .w > span"), { yPercent: 112, duration: 0.95 * K, ease: "expo.out", stagger: 0.08 * K }, 0.28 * K);
tl.from(q(".rule"), { scaleX: 0, duration: 0.8 * K, ease: "power2.inOut" }, 0.7 * K);
tl.from(q(".sub"), { opacity: 0, y: 26 * U, duration: 0.8 * K, ease: "power2.out" }, 0.9 * K);
tl.to(q(".block"), { y: -16 * U, duration: D, ease: "none" }, 0);`,
    };
  },
};

/** Where words sit over a photo, inside the safe area. */
const TEXT_AT = ["upper", "middle", "lower"] as const;
const placeAt = (at: unknown) =>
  at === "upper" ? "top: var(--safe-top);" : at === "middle" ? `top: calc(var(--safe-top) + (100% - var(--safe-top) - var(--safe-bottom)) * 0.38);` : `${ABOVE_BOTTOM};`;

const hook: Template = {
  name: "hook",
  summary:
    "The first scene of a reel: the product photo slams in full-frame (a fast zoom settling into a slow push) with the hook words on solid boxes from the third frame, so the very first frame already shows the product and the reason to stay.",
  params: {
    photo: { type: "media", required: true, doc: "The most striking photo: the whole look on the model, or the detail that sells it." },
    more: { type: "medias", max: 3, doc: "Up to 3 more photos cut in on the beat after the first, under the same words: the proof the hook promises (each colour for a colour question, the pocket for a pockets hook)." },
    line: { type: "text", required: true, max: 42, doc: "The hook: 2-7 words that make a scrolling thumb stop (a true number, a question, a promise: \"300+ women chose this set\")." },
    kicker: { type: "text", max: 28, doc: "A small gold tag above it (\"Bestseller\", \"Under ₹999\")." },
    textAt: { type: "choice", choices: TEXT_AT, doc: "Where the words sit; keep them off the face (on a full-length photo, upper covers the head). Default lower." },
    focusX: { type: "number", min: 0, max: 1, doc: "Where the zoom centres, 0-1 across (default 0.5)." },
    focusY: { type: "number", min: 0, max: 1, doc: "0-1 down (default 0.35)." },
  },
  build(p, ctx) {
    const fx = num(p.focusX, 0.5) * 100;
    const fy = num(p.focusY, 0.35) * 100;
    const line = str(p.line);
    const size = line.length <= 14 ? 104 : line.length <= 24 ? 90 : line.length <= 34 ? 78 : 70;
    const photos = [str(p.photo), ...list(p.more)];
    // The first photo holds for the slam and the words; the rest cut in on the following beats.
    let cuts = ctx.beats.filter((t) => t >= 0.6 && t < ctx.duration - 0.3).slice(0, photos.length - 1);
    if (cuts.length < photos.length - 1) cuts = Array.from({ length: photos.length - 1 }, (_, i) => 0.6 + ((i + 1) * (ctx.duration - 0.6)) / photos.length);
    cuts = cuts.map((t) => Math.round(t * 1000) / 1000);
    return {
      html: `${photos.map((src) => `<div class="shot"><img class="photo" data-layout-allow-overflow src="${esc(src)}" alt=""></div>`).join("\n")}
<div class="text">
  ${str(p.kicker) ? `<div class="kicker"><span>${esc(str(p.kicker))}</span></div>` : ""}
  <div class="line"><span>${esc(line)}</span></div>
</div>`,
      css: `.shot { position: absolute; inset: 0; overflow: hidden; opacity: 0; }
.shot:first-child { opacity: 1; }
.photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${fx}% ${fy}%; transform-origin: ${fx}% ${fy}%; }
.text { position: absolute; left: var(--safe-x); right: var(--safe-x); ${placeAt(p.textAt)} text-wrap: balance; }
.kicker { margin-bottom: ${u(18)}; }
.kicker span { display: inline-block; padding: ${u(12)} ${u(20)}; background: var(--gold); color: var(--wine-deep); font: 600 ${u(36)}/1 var(--font-text); letter-spacing: .14em; text-transform: uppercase; }
.line span { font: 600 ${u(size)}/1.3 var(--font-text); color: var(--ivory); }
${BOXED(".line span")}`,
      script: `const shots = q(".shot"), cuts = ${JSON.stringify(cuts)};
const first = shots[0].querySelector("img");
tl.fromTo(first, { scale: 1.3 }, { scale: 1.05, duration: 0.42, ease: "expo.out", immediateRender: true }, 0);
tl.to(first, { scale: 1.16, duration: Math.max(0.2, (cuts[0] ?? D) - 0.42), ease: "sine.inOut" }, 0.42);
cuts.forEach((at, i) => {
  const s = shots[i + 1], end = cuts[i + 1] ?? D;
  tl.set(shots[i], { opacity: 0 }, at);
  tl.set(s, { opacity: 1 }, at);
  tl.fromTo(s.querySelector("img"), { scale: 1.12 }, { scale: 1.02, duration: end - at, ease: "power2.out", immediateRender: false }, at);
});
tl.from(q(".kicker"), { opacity: 0, x: -30 * U, duration: 0.3, ease: "power3.out" }, 0.07);
tl.from(q(".line"), { opacity: 0, y: 30 * U, scale: 0.96, transformOrigin: "0% 100%", duration: 0.34, ease: "back.out(1.8)" }, 0.1);`,
    };
  },
};

const hero: Template = {
  name: "hero",
  summary: "A full-frame product photo that keeps moving (push-in, pull-out, pans), with an optional name / price on solid boxes.",
  params: {
    photo: { type: "media", required: true, doc: "The photo (chat:<n>, asset:<id>)." },
    move: { type: "choice", choices: MOVES, doc: "How the camera moves over the scene. Default push-in." },
    focusX: { type: "number", min: 0, max: 1, doc: "Where the move centres, 0-1 across (default 0.5)." },
    focusY: { type: "number", min: 0, max: 1, doc: "0-1 down (default 0.4: faces and necklines sit high)." },
    kicker: { type: "text", max: 32, doc: "Small gold tag (\"Pure cotton\")." },
    name: { type: "text", max: 40, doc: "The product's name, short (\"Embroidered co-ord set\")." },
    price: { type: "text", max: 20, doc: "\"₹1,499\"." },
    note: { type: "text", max: 50, doc: "A short line under the price." },
    textAt: { type: "choice", choices: TEXT_AT, doc: "Where the words sit; keep them off the face (on a full-length photo, upper covers the head). Default lower." },
  },
  build(p) {
    const fx = num(p.focusX, 0.5) * 100;
    const fy = num(p.focusY, 0.4) * 100;
    const hasText = ["kicker", "name", "price", "note"].some((k) => str(p[k]));
    const name = str(p.name);
    const nameSize = name.length <= 18 ? 100 : name.length <= 28 ? 88 : 76;
    return {
      html: `<img class="photo" data-layout-allow-overflow src="${esc(str(p.photo))}" alt="">
${hasText ? `<div class="card">
  ${str(p.kicker) ? `<div class="kicker"><span>${esc(str(p.kicker))}</span></div>` : ""}
  ${name ? `<div class="name"><span>${esc(name)}</span></div>` : ""}
  ${str(p.price) ? `<div class="price"><span>${esc(str(p.price))}</span></div>` : ""}
  ${str(p.note) ? `<div class="note"><span>${esc(str(p.note))}</span></div>` : ""}
</div>` : ""}`,
      css: `.photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${fx}% ${fy}%; transform-origin: ${fx}% ${fy}%; }
.card { position: absolute; left: var(--safe-x); right: var(--safe-x); ${placeAt(p.textAt)} text-wrap: balance; }
.card > div + div { margin-top: ${u(14)}; }
.kicker span { display: inline-block; padding: ${u(12)} ${u(20)}; background: var(--gold); color: var(--wine-deep); font: 600 ${u(36)}/1 var(--font-text); letter-spacing: .14em; text-transform: uppercase; }
.name span { font: 600 ${u(nameSize)}/1.3 var(--font-display); color: var(--ivory); }
.price span { font: italic 600 ${u(84)}/1.3 var(--font-display); color: var(--gold-soft); }
.note span { font: 500 ${u(42)}/1.4 var(--font-text); color: var(--ivory); }
${BOXED(".name span, .price span, .note span")}`,
      script: `${moveScript(".photo", str(p.move) || "push-in")}
tl.from(q(".kicker"), { opacity: 0, x: -30 * U, duration: 0.55 * K, ease: "power3.out" }, 0.2 * K);
tl.from(q(".name"), { opacity: 0, y: 40 * U, duration: 0.7 * K, ease: "expo.out" }, 0.3 * K);
tl.from(q(".price"), { opacity: 0, y: 30 * U, scale: 0.92, transformOrigin: "0% 50%", duration: 0.6 * K, ease: "back.out(1.6)" }, 0.6 * K);
tl.from(q(".note"), { opacity: 0, duration: 0.6 * K, ease: "power1.out" }, 0.8 * K);`,
    };
  },
};

const beatsT: Template = {
  name: "beats",
  summary: "A photo montage cut on the music: a new photo on each beat (or every few, or at your own times), each landing with a small punch-in.",
  params: {
    photos: { type: "medias", required: true, min: 2, max: 12, doc: "The photos in order; they repeat if there are more cuts than photos. Put the strongest on a bar's downbeat." },
    every: { type: "number", min: 1, max: 8, doc: "Cut every Nth beat (default 1; 2 on fast songs)." },
    cuts: { type: "numbers", max: 24, doc: "Cut at these scene seconds instead of the beats." },
    punch: { type: "number", min: 1, max: 1.2, doc: "How far each photo starts zoomed (default 1.06)." },
    caption: { type: "text", max: 40, doc: "A line held over the montage." },
    captionAt: { type: "choice", choices: TEXT_AT, doc: "Where the caption sits. Default lower." },
  },
  build(p, ctx) {
    const photos = list(p.photos);
    const every = Math.max(1, Math.round(num(p.every, 1)));
    let cuts = (Array.isArray(p.cuts) ? (p.cuts as number[]) : ctx.beats.filter((_, i) => i % every === 0)).filter((t) => t > 0.05 && t < ctx.duration - 0.05);
    if (!cuts.length) cuts = Array.from({ length: photos.length - 1 }, (_, i) => ((i + 1) * ctx.duration) / photos.length);
    const punch = num(p.punch, 1.06);
    return {
      html: `${photos.map((src, i) => `<div class="shot" data-i="${i}"><img data-layout-allow-overflow src="${esc(src)}" alt=""></div>`).join("\n")}
${str(p.caption) ? `<div class="caption"><span>${esc(str(p.caption))}</span></div>` : ""}`,
      css: `.shot { position: absolute; inset: 0; opacity: 0; overflow: hidden; }
.shot:first-child { opacity: 1; }
.shot img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 40%; }
.caption { position: absolute; left: var(--safe-x); right: var(--safe-x); ${placeAt(p.captionAt)} text-wrap: balance; }
.caption span { font: 600 ${u(80)}/1.3 var(--font-display); color: var(--ivory); }
${BOXED(".caption span")}`,
      script: `const cuts = ${JSON.stringify(cuts.map((t) => Math.round(t * 1000) / 1000))};
const shots = q(".shot");
const starts = [0, ...cuts], ends = [...cuts, D];
starts.forEach((at, i) => {
  const s = shots[i % shots.length], img = s.querySelector("img");
  if (i > 0) { tl.set(shots[(i - 1) % shots.length], { opacity: 0 }, at); tl.set(s, { opacity: 1 }, at); }
  tl.fromTo(img, { scale: ${punch} }, { scale: 1, duration: Math.min(0.45, (ends[i] - at) * 0.8), ease: "power3.out", immediateRender: i === 0 }, at);
  tl.fromTo(img, { xPercent: i % 2 ? 1.5 : -1.5 }, { xPercent: i % 2 ? -1.5 : 1.5, duration: ends[i] - at, ease: "none", immediateRender: i === 0 }, at);
});
tl.from(q(".caption"), { opacity: 0, y: 30 * U, duration: 0.6 * K, ease: "expo.out" }, 0.15 * K);`,
    };
  },
};

const cutout: Template = {
  name: "cutout",
  summary: "The product cut out (a PNG with no background, photo_edit cutout) floating on a brand backdrop, with name and price above it.",
  params: {
    product: { type: "media", required: true, doc: "The cut-out PNG (asset:<id> from photo_edit cutout)." },
    backdrop: { type: "background", doc: "Palette name, CSS colour, or a photo (dimmed). Default blush." },
    kicker: { type: "text", max: 40, doc: "Small caps line." },
    name: { type: "text", max: 48, doc: "The product's name." },
    price: { type: "text", max: 20, doc: "\"₹1,499\"." },
    note: { type: "text", max: 60, doc: "A line under the name." },
  },
  build(p) {
    const bg = background(p.backdrop, "blush");
    const t = tone(bg.dark);
    return {
      html: `${bg.html}
<div class="glow" data-layout-allow-overflow></div>
<div class="text">
  ${str(p.kicker) ? `<div class="kicker">${esc(str(p.kicker))}</div>` : ""}
  ${str(p.name) ? `<div class="name">${words(str(p.name))}</div>` : ""}
  ${str(p.note) ? `<div class="note">${esc(str(p.note))}</div>` : ""}
  ${str(p.price) ? `<div class="price">${esc(str(p.price))}</div>` : ""}
</div>
<div class="stage"><div class="shadow"></div><img class="product" src="${esc(str(p.product))}" alt=""></div>`,
      css: `${bg.css}
.glow { position: absolute; left: 50%; top: 58%; width: ${u(900)}; height: ${u(900)}; margin: ${u(-450)} 0 0 ${u(-450)}; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--ivory) 70%, transparent), transparent 65%); }
.text { position: absolute; left: var(--safe-x); right: var(--safe-x); top: var(--safe-top); text-align: center; }
.kicker { font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: ${t.accent}; margin-bottom: ${u(20)}; }
.name { font: 500 ${u(88)}/1.02 var(--font-display); color: ${t.head}; }
.name .w { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: .08em; }
.name .w > span { display: inline-block; }
.note { margin-top: ${u(14)}; font: 400 ${u(42)}/1.3 var(--font-text); color: ${t.body}; }
.price { margin-top: ${u(14)}; font: italic 600 ${u(84)}/1 var(--font-display); color: ${t.accent}; }
.stage { position: absolute; left: 0; right: 0; top: 33%; bottom: 9%; display: flex; justify-content: center; align-items: flex-end; }
.product { position: relative; max-width: 88%; max-height: 100%; object-fit: contain; filter: drop-shadow(0 ${u(30)} ${u(40)} hsl(345 40% 12% / .28)); }
.shadow { position: absolute; bottom: ${u(-10)}; left: 50%; width: ${u(520)}; height: ${u(60)}; margin-left: ${u(-260)}; border-radius: 50%; background: radial-gradient(closest-side, hsl(345 40% 12% / .35), transparent); }`,
      // Over a photo, the owner wants the card fully opaque for its last 2-3 s: the photo fades out under solid wine.
      script: `${bg.photo ? `tl.fromTo(q(".bg"), { scale: 1.1 }, { scale: 1.02, duration: D, ease: "sine.out" }, 0);
const solid = Math.min(3, Math.max(2, D - 1.5));
tl.to(q(".solid"), { opacity: 1, duration: 0.5, ease: "sine.inOut" }, Math.max(0, D - solid - 0.5));` : `tl.fromTo(q(".bg"), { xPercent: -2 }, { xPercent: 2, duration: D, ease: "sine.inOut" }, 0);`}
tl.from(q(".glow"), { opacity: 0, scale: 0.7, duration: 1.4 * K, ease: "power2.out" }, 0);
tl.from(q(".product"), { opacity: 0, y: 140 * U, scale: 0.94, duration: 1.15 * K, ease: "expo.out" }, 0.15 * K);
tl.from(q(".shadow"), { opacity: 0, scaleX: 0.5, duration: 1.0 * K, ease: "expo.out" }, 0.3 * K);
tl.to(q(".product"), { y: -12 * U, duration: 1.6, ease: "sine.inOut", yoyo: true, repeat: Math.max(0, Math.floor((D - 1.3 * K) / 1.6) - 1) }, 1.3 * K);
tl.from(q(".kicker"), { opacity: 0, y: 16 * U, duration: 0.8 * K, ease: "power3.out" }, 0.45 * K);
tl.from(q(".name .w > span"), { yPercent: 112, duration: 0.9 * K, ease: "expo.out", stagger: 0.07 * K }, 0.55 * K);
tl.from(q(".note"), { opacity: 0, duration: 0.7 * K }, 0.85 * K);
tl.from(q(".price"), { opacity: 0, y: 20 * U, duration: 0.7 * K, ease: "back.out(1.5)" }, 0.95 * K);`,
    };
  },
};

const detail: Template = {
  name: "detail",
  summary: "A close-up on part of a photo (embroidery, fabric, a neckline) pushing in slowly, with up to 3 short call-outs.",
  params: {
    photo: { type: "media", required: true, doc: "The photo (a sharp, large one: the close-up crops it)." },
    x: { type: "number", min: 0, max: 1, doc: "The detail's centre, 0-1 across." },
    y: { type: "number", min: 0, max: 1, doc: "0-1 down." },
    zoom: { type: "number", min: 1.2, max: 4, doc: "How close (default 2.2)." },
    label: { type: "text", max: 30, doc: "Small caps line at the top (\"The details\")." },
    callouts: { type: "list", max: 3, doc: "Up to 3 short facts (\"Hand block print\", \"Pure cotton\")." },
  },
  build(p) {
    const x = num(p.x, 0.5) * 100;
    const y = num(p.y, 0.5) * 100;
    const zoom = num(p.zoom, 2.2);
    const callouts = list(p.callouts).slice(0, 3);
    return {
      html: `<img class="photo" data-layout-allow-overflow src="${esc(str(p.photo))}" alt="">
<div class="vignette"></div>
${str(p.label) ? `<div class="label">${esc(str(p.label))}</div>` : ""}
${callouts.length ? `<div class="callouts">${callouts.map((c) => `<div class="callout"><i></i><span>${esc(c)}</span></div>`).join("")}</div>` : ""}`,
      css: `.photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${x}% ${y}%; transform-origin: ${x}% ${y}%; }
.vignette { position: absolute; inset: 0; background: radial-gradient(130% 90% at 50% 45%, transparent 58%, hsl(345 40% 10% / .32)); }
.label { position: absolute; left: var(--safe-x); top: var(--safe-top); padding: ${u(14)} ${u(20)}; background: hsl(345 40% 10% / .55); font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: var(--gold-soft); }
.callouts { position: absolute; left: var(--safe-x); ${ABOVE_BOTTOM}; display: flex; flex-direction: column; gap: ${u(20)}; padding: ${u(34)} ${u(40)}; background: hsl(345 40% 12% / .88); border-left: ${u(3)} solid var(--gold); }
.callout { display: flex; align-items: center; gap: ${u(20)}; font: 500 ${u(52)}/1.15 var(--font-text); letter-spacing: .02em; color: var(--ivory); }
.callout i { flex: none; width: ${u(36)}; height: ${u(2)}; background: var(--gold); transform-origin: 0 50%; }`,
      script: `tl.fromTo(q(".photo"), { scale: ${zoom} }, { scale: ${Math.round(zoom * 1.09 * 100) / 100}, duration: D, ease: "sine.inOut" }, 0);
tl.from(q(".vignette"), { opacity: 0, duration: 0.8 * K }, 0);
tl.from(q(".callouts"), { opacity: 0, x: -30 * U, duration: 0.45 * K, ease: "power3.out" }, 0.1 * K);
tl.from(q(".label"), { opacity: 0, x: -24 * U, duration: 0.5 * K, ease: "power3.out" }, 0.05 * K);
q(".callout").forEach((c, i) => {
  const at = (0.12 + i * 0.3) * K;
  tl.from(c.querySelector("i"), { scaleX: 0, duration: 0.45 * K, ease: "power2.inOut" }, at);
  tl.from(c.querySelector("span"), { opacity: 0, x: -24 * U, duration: 0.45 * K, ease: "power3.out" }, at + 0.06 * K);
});`,
    };
  },
};

const price: Template = {
  name: "price",
  summary: "The offer: label, the MRP struck through, the price big, a badge (\"40% off\") that pops, a note.",
  params: {
    price: { type: "text", required: true, max: 20, doc: "\"₹1,499\"." },
    mrp: { type: "text", max: 20, doc: "\"₹2,499\": shown struck through." },
    off: { type: "text", max: 14, doc: "Badge text (\"40% off\")." },
    label: { type: "text", max: 36, doc: "Small caps line (\"Launch price\")." },
    note: { type: "text", max: 60, doc: "\"Free shipping across India\"." },
    background: { type: "background", doc: "A photo of the product (best on a reel: the price sits on its own card over it), or a palette name / CSS colour. Default wine." },
    textAt: { type: "choice", choices: TEXT_AT, doc: "Where the card sits over a photo; keep it off the face and the garment's best part. Default lower over a photo, middle on a colour." },
  },
  build(p) {
    const bg = background(p.background, "wine", 0.3);
    const t = tone(bg.dark);
    const at = str(p.textAt) || (bg.photo ? "lower" : "middle");
    const justify = at === "upper" ? "flex-start" : at === "lower" ? "flex-end" : "center";
    return {
      html: `${bg.html}
<div class="block"><div class="card">
  ${str(p.label) ? `<div class="label">${esc(str(p.label))}</div>` : ""}
  ${str(p.mrp) ? `<div class="mrp"><span>${esc(str(p.mrp))}</span><i></i></div>` : ""}
  <div class="row"><div class="price">${esc(str(p.price))}</div>${str(p.off) ? `<div class="off">${esc(str(p.off))}</div>` : ""}</div>
  <div class="rule"></div>
  ${str(p.note) ? `<div class="note">${esc(str(p.note))}</div>` : ""}
</div></div>`,
      css: `${bg.css}
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: ${justify}; align-items: center; text-align: center; }
.card { display: flex; flex-direction: column; align-items: center; ${bg.photo ? `padding: ${u(48)} ${u(64)}; background: hsl(345 40% 14% / .9);` : ""} }
.label { font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: ${t.accent}; margin-bottom: ${u(40)}; }
.mrp { position: relative; font: 400 ${u(70)}/1 var(--font-display); color: ${t.body}; margin-bottom: ${u(12)}; }
.mrp i { position: absolute; left: -6%; right: -6%; top: 52%; height: ${u(3)}; background: ${t.rule}; transform-origin: 0 50%; }
.row { position: relative; display: flex; align-items: flex-start; gap: ${u(26)}; }
.price { font: 600 ${u(196)}/1 var(--font-display); color: ${t.head}; letter-spacing: -0.01em; }
.off { flex: none; margin-top: ${u(-30)}; width: ${u(160)}; height: ${u(160)}; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-align: center; padding: ${u(18)}; box-sizing: border-box; background: var(--gold); color: var(--wine-deep); font: 600 ${u(32)}/1.05 var(--font-text); text-transform: uppercase; letter-spacing: .04em; transform: rotate(-10deg); }
.rule { width: ${u(120)}; height: ${u(2)}; background: ${t.rule}; margin: ${u(44)} 0 ${u(28)}; }
.note { font: 400 ${u(42)}/1.3 var(--font-text); color: ${t.body}; }`,
      // Over a photo, the owner wants the card fully opaque for its last 2-3 s: the photo fades out under solid wine.
      script: `${bg.photo ? `tl.fromTo(q(".bg"), { scale: 1.1 }, { scale: 1.02, duration: D, ease: "sine.out" }, 0);
const solid = Math.min(3, Math.max(2, D - 1.5));
tl.to(q(".solid"), { opacity: 1, duration: 0.5, ease: "sine.inOut" }, Math.max(0, D - solid - 0.5));` : `tl.fromTo(q(".bg"), { xPercent: 2 }, { xPercent: -2, duration: D, ease: "sine.inOut" }, 0);`}
tl.from(q(".card"), { opacity: 0, scale: 0.94, duration: 0.3 * K, ease: "power3.out" }, 0);
tl.from(q(".label"), { opacity: 0, y: 18 * U, duration: 0.4 * K, ease: "power3.out" }, 0.05 * K);
tl.from(q(".mrp span"), { opacity: 0, y: 20 * U, duration: 0.35 * K, ease: "power2.out" }, 0.1 * K);
tl.from(q(".mrp i"), { scaleX: 0, duration: 0.3 * K, ease: "power2.in" }, 0.3 * K);
tl.from(q(".price"), { opacity: 0, y: 70 * U, scale: 0.9, duration: 0.6 * K, ease: "expo.out" }, 0.4 * K);
tl.from(q(".off"), { scale: 0, rotation: -60, duration: 0.5 * K, ease: "back.out(2.2)" }, 0.65 * K);
tl.from(q(".rule"), { scaleX: 0, duration: 0.5 * K, ease: "power2.inOut" }, 0.6 * K);
tl.from(q(".note"), { opacity: 0, duration: 0.5 * K }, 0.75 * K);
tl.to(q(".off"), { rotation: -4, scale: 1.04, duration: 1.2, ease: "sine.inOut", yoyo: true, repeat: Math.max(0, Math.floor((D - 1.2 * K) / 1.2) - 1) }, 1.2 * K);`,
    };
  },
};

const swatches: Template = {
  name: "swatches",
  summary: "The colours it comes in: circles (a colour or a photo of each) that bloom in one by one with their names.",
  params: {
    colors: { type: "list", required: true, max: 6, doc: "Each \"Name #hex\" (\"Rose pink #e8a0b4\"), or just names when photos are given." },
    photos: { type: "medias", max: 6, doc: "A photo per colour, in the same order (shown in the circles)." },
    headline: { type: "text", max: 40, doc: "Default \"Available in\"." },
    background: { type: "background", doc: "Default shell." },
  },
  build(p) {
    const bg = background(p.background, "shell");
    const t = tone(bg.dark);
    const photos = list(p.photos);
    const items = list(p.colors).slice(0, 6).map((c, i) => {
      const hex = /#[0-9a-f]{3,8}\b/i.exec(c)?.[0] ?? null;
      return { name: c.replace(/#[0-9a-f]{3,8}\b/i, "").trim() || `Colour ${i + 1}`, hex, photo: photos[i] ?? null };
    });
    const size = items.length <= 3 ? 260 : items.length === 4 ? 230 : 200;
    return {
      html: `${bg.html}
<div class="block">
  <div class="headline">${words(str(p.headline) || "Available in")}</div>
  <div class="grid">${items
    .map((it) => `<div class="sw"><div class="dot"${it.hex ? ` style="background:${it.hex}"` : ""}>${it.photo ? `<img src="${esc(it.photo)}" alt="">` : ""}</div><div class="nm">${esc(it.name)}</div></div>`)
    .join("")}</div>
</div>`,
      css: `${bg.css}
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
.headline { font: 500 ${u(104)}/1.02 var(--font-display); color: ${t.head}; margin-bottom: ${u(70)}; }
.headline .w { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: .08em; }
.headline .w > span { display: inline-block; }
.grid { display: flex; flex-wrap: wrap; justify-content: center; gap: ${u(50)} ${u(56)}; max-width: ${u(900)}; }
.sw { display: flex; flex-direction: column; align-items: center; width: ${u(size)}; }
.dot { width: ${u(size)}; height: ${u(size)}; border-radius: 50%; overflow: hidden; background: var(--linen); box-shadow: 0 0 0 ${u(3)} var(--ivory), 0 0 0 ${u(5)} var(--gold), 0 ${u(24)} ${u(40)} hsl(345 40% 12% / .18); }
.dot img { width: 100%; height: 100%; object-fit: cover; }
.nm { margin-top: ${u(26)}; font: 500 ${u(40)}/1.15 var(--font-text); letter-spacing: .06em; color: ${t.body}; }`,
      script: `tl.from(q(".headline .w > span"), { yPercent: 112, duration: 0.9 * K, ease: "expo.out", stagger: 0.07 * K }, 0.15 * K);
tl.from(q(".dot"), { scale: 0.4, opacity: 0, duration: 0.85 * K, ease: "expo.out", stagger: 0.12 * K }, 0.5 * K);
tl.from(q(".nm"), { opacity: 0, y: 14 * U, duration: 0.6 * K, ease: "power2.out", stagger: 0.12 * K }, 0.75 * K);
tl.to(q(".dot img"), { scale: 1.1, duration: D, ease: "none" }, 0);
tl.to(q(".grid"), { y: -14 * U, duration: D, ease: "none" }, 0);`,
    };
  },
};

const sizes: Template = {
  name: "sizes",
  summary: "The sizes as chips that drop in, a highlight sweeping across them, and a fit note.",
  params: {
    sizes: { type: "list", required: true, max: 8, doc: "\"XS\", \"S\", \"M\"… or \"Free size\"." },
    headline: { type: "text", max: 40, doc: "Default \"Find your size\"." },
    note: { type: "text", max: 70, doc: "\"Relaxed fit · true to size\"." },
    background: { type: "background", doc: "Default ivory." },
  },
  build(p) {
    const bg = background(p.background, "ivory");
    const t = tone(bg.dark);
    return {
      html: `${bg.html}
<div class="block">
  <div class="headline">${words(str(p.headline) || "Find your size")}</div>
  <div class="chips">${list(p.sizes)
    .slice(0, 8)
    .map((s) => `<div class="chip"><b class="hl" data-layout-allow-overflow></b><span>${esc(s)}</span></div>`)
    .join("")}</div>
  ${str(p.note) ? `<div class="note">${esc(str(p.note))}</div>` : ""}
</div>`,
      css: `${bg.css}
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
.headline { font: 500 ${u(104)}/1.02 var(--font-display); color: ${t.head}; margin-bottom: ${u(64)}; }
.headline .w { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: .08em; }
.headline .w > span { display: inline-block; }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: ${u(24)}; max-width: ${u(900)}; }
.chip { position: relative; overflow: hidden; min-width: ${u(140)}; padding: ${u(30)} ${u(34)}; box-sizing: border-box; border: ${u(2)} solid ${t.rule}; border-radius: ${u(10)}; font: 500 ${u(44)}/1 var(--font-text); letter-spacing: .06em; color: ${t.head}; }
.chip span { position: relative; }
.chip .hl { position: absolute; inset: 0; background: ${bg.dark ? "hsl(40 45% 80% / .22)" : "hsl(349 56% 89% / .9)"}; transform: translateX(-101%); }
.note { margin-top: ${u(56)}; font: 400 ${u(42)}/1.3 var(--font-text); color: ${t.body}; }`,
      script: `tl.from(q(".headline .w > span"), { yPercent: 112, duration: 0.9 * K, ease: "expo.out", stagger: 0.07 * K }, 0.15 * K);
tl.from(q(".chip"), { opacity: 0, y: -50 * U, duration: 0.7 * K, ease: "back.out(1.7)", stagger: 0.07 * K }, 0.5 * K);
tl.from(q(".note"), { opacity: 0, duration: 0.7 * K }, 1.0 * K);
const hls = q(".chip .hl");
const start = 1.1 * K, each = Math.max(0.12, Math.min(0.3, (D - start - 0.4) / Math.max(1, hls.length)));
hls.forEach((h, i) => {
  tl.fromTo(h, { xPercent: -101 }, { xPercent: 0, duration: each * 0.7, ease: "power2.out" }, start + i * each);
  tl.to(h, { xPercent: 101, duration: each * 0.7, ease: "power2.in" }, start + (i + 1) * each);
});`,
    };
  },
};

const split: Template = {
  name: "split",
  summary: "Two photos together (front and back, styled and flat, two colours): the first fills the frame, then the second slides in beside or under it, with labels.",
  params: {
    photos: { type: "medias", required: true, min: 2, max: 2, doc: "The two photos." },
    labels: { type: "list", max: 2, doc: "A short label for each (\"Front\", \"Back\"); name a colour only after looking at its photo." },
    layout: { type: "choice", choices: ["stack", "side"], doc: "stack (top and bottom, default on a reel) or side by side." },
    focusY: { type: "numbers", max: 2, doc: "For each photo, which part shows, 0-1 down (default 0.3 for the first, 0.15 for the second when stacked, keeping heads in)." },
    focusX: { type: "numbers", max: 2, doc: "Side by side, each pane shows a narrow slice: for each photo, where the person stands, 0-1 across (default 0.5), so the face and the outfit stay in." },
  },
  build(p, ctx) {
    const [a, b] = list(p.photos);
    const labels = list(p.labels);
    const side = p.layout === "side" || (p.layout === undefined && ctx.width >= ctx.height);
    const fy = (i: number, fallback: number) => Math.round(num(Array.isArray(p.focusY) ? p.focusY[i] : undefined, fallback) * 100);
    const fx = (i: number) => Math.round(num(Array.isArray(p.focusX) ? p.focusX[i] : undefined, 0.5) * 100);
    // The first pane is clipped to its half, leaving a 10-unit gap; the second slides into the other half.
    const half = `${Math.round((50 + (5 / (side ? 1080 : (1080 * ctx.height) / ctx.width)) * 100) * 100) / 100}%`;
    return {
      html: `<div class="panes ${side ? "side" : "stack"}">
  <div class="pane a"><img data-layout-allow-overflow src="${esc(a)}" alt="" style="object-position: ${fx(0)}% ${fy(0, 0.3)}%">${labels[0] ? `<div class="lb">${esc(labels[0])}</div>` : ""}</div>
  <div class="pane b"><img data-layout-allow-overflow src="${esc(b)}" alt="" style="object-position: ${fx(1)}% ${fy(1, side ? 0.4 : 0.15)}%">${labels[1] ? `<div class="lb">${esc(labels[1])}</div>` : ""}</div>
</div>`,
      css: `.panes { position: absolute; inset: 0; overflow: hidden; background: var(--ivory); }
.pane { position: absolute; overflow: hidden; }
.pane img { width: 100%; height: 100%; object-fit: cover; }
.pane.a { inset: 0; }
.stack .pane.b { left: 0; right: 0; bottom: 0; height: calc(50% - ${u(5)}); }
.side .pane.b { top: 0; bottom: 0; right: 0; width: calc(50% - ${u(5)}); }
.lb { position: absolute; font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .16em; text-transform: uppercase; color: var(--ivory); padding: ${u(16)} ${u(24)}; background: hsl(345 40% 16% / .9); }
.stack .a .lb { left: var(--safe-x); top: var(--safe-top); }
.stack .b .lb { left: var(--safe-x); top: ${u(40)}; }
.side .a .lb { left: var(--safe-x); top: var(--safe-top); }
.side .b .lb { left: ${u(30)}; top: var(--safe-top); }`,
      script: `const a = q(".pane.a")[0], b = q(".pane.b")[0];
tl.fromTo(a, { clipPath: "inset(0% 0% 0% 0%)" }, { clipPath: "${side ? `inset(0% ${half} 0% 0%)` : `inset(0% 0% ${half} 0%)`}", duration: 0.5 * K, ease: "power3.inOut" }, 0.12 * K);
tl.fromTo(b, { ${side ? "xPercent" : "yPercent"}: 100 }, { ${side ? "xPercent" : "yPercent"}: 0, duration: 0.5 * K, ease: "power3.inOut" }, 0.12 * K);
tl.fromTo(q(".pane.a img"), { scale: 1.0 }, { scale: 1.08, duration: D, ease: "sine.inOut" }, 0);
tl.fromTo(q(".pane.b img"), { scale: 1.14 }, { scale: 1.03, duration: D, ease: "sine.out" }, 0);
tl.from(q(".lb"), { opacity: 0, x: -20 * U, duration: 0.45 * K, ease: "power2.out", stagger: 0.15 * K }, 0.45 * K);`,
    };
  },
};

const quote: Template = {
  name: "quote",
  summary: "Words in the brand's serif: a customer's review, a promise, a line about the craft. Words fade in one after another.",
  params: {
    text: { type: "text", required: true, max: 140, doc: "The words (under 20 reads best)." },
    by: { type: "text", max: 40, doc: "Who said it (\"Ananya, Pune\")." },
    stars: { type: "number", min: 0, max: 5, doc: "Star rating to show (a review)." },
    background: { type: "background", doc: "Default shell." },
  },
  build(p) {
    const bg = background(p.background, "shell");
    const t = tone(bg.dark);
    const text = str(p.text);
    const stars = Math.round(num(p.stars, 0));
    return {
      html: `${bg.html}
<div class="block">
  <div class="mark">“</div>
  ${stars ? `<div class="stars">${"★".repeat(stars)}</div>` : ""}
  <div class="text">${esc(text)
    .split(/\s+/)
    .map((w) => `<span>${w}</span>`)
    .join(" ")}</div>
  ${str(p.by) ? `<div class="by">${esc(str(p.by))}</div>` : ""}
</div>`,
      css: `${bg.css}
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
.mark { font: 400 ${u(260)}/0.6 var(--font-display); color: var(--gold); height: ${u(120)}; }
.stars { font: 400 ${u(44)}/1 var(--font-text); letter-spacing: .2em; color: var(--gold); margin-bottom: ${u(28)}; }
.text { font: italic 400 ${u(text.length > 90 ? 62 : text.length > 50 ? 74 : 90)}/1.18 var(--font-display); color: ${t.head}; max-width: ${u(900)}; }
.text { word-spacing: .12em; }
.text span { display: inline-block; }
.by { margin-top: ${u(48)}; font: 600 ${u(38)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: ${t.accent}; }`,
      script: `tl.from(q(".mark"), { opacity: 0, y: 40 * U, scale: 0.8, duration: 0.9 * K, ease: "expo.out" }, 0.1 * K);
tl.from(q(".stars"), { opacity: 0, scale: 0.6, duration: 0.6 * K, ease: "back.out(2)" }, 0.3 * K);
const ws = q(".text span");
tl.from(ws, { opacity: 0, y: 18 * U, duration: 0.6 * K, ease: "power2.out", stagger: Math.min(0.09, (D * 0.45) / Math.max(1, ws.length)) }, 0.4 * K);
tl.from(q(".by"), { opacity: 0, duration: 0.7 * K }, Math.min(D * 0.7, 0.4 * K + ws.length * 0.09 + 0.3));
tl.to(q(".block"), { y: -14 * U, duration: D, ease: "none" }, 0);`,
    };
  },
};

const clip: Template = {
  name: "clip",
  summary: "A video clip filling the frame (muted; the song plays over it), pushing in slowly, with an optional caption.",
  params: {
    video: { type: "media", required: true, doc: "A clip (asset:<id>) or a library video (video:<id>)." },
    from: { type: "number", min: 0, doc: "Seconds into the clip to start from (default 0)." },
    caption: { type: "text", max: 48, doc: "A line over it." },
    captionAt: { type: "choice", choices: TEXT_AT, doc: "Where the caption sits. Default lower." },
  },
  build(p, ctx) {
    return {
      html: `<video class="vid" data-layout-allow-overflow src="${esc(str(p.video))}" data-start="0" data-duration="${ctx.duration}" data-media-start="${num(p.from, 0)}" muted playsinline></video>
${str(p.caption) ? `<div class="caption"><span>${esc(str(p.caption))}</span></div>` : ""}`,
      css: `.vid { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.caption { position: absolute; left: var(--safe-x); right: var(--safe-x); ${placeAt(p.captionAt)} text-wrap: balance; }
.caption span { font: 600 ${u(76)}/1.3 var(--font-display); color: var(--ivory); }
${BOXED(".caption span")}`,
      script: `tl.fromTo(q(".vid"), { scale: 1.0 }, { scale: 1.06, duration: D, ease: "none" }, 0);
tl.from(q(".caption"), { opacity: 0, y: 30 * U, duration: 0.6 * K, ease: "expo.out" }, 0.2 * K);`,
    };
  },
};

const endcard: Template = {
  name: "endcard",
  summary: "The close of every video, on screen 4-5 s: the PariBelle wordmark settling into place, a gold rule, a line, the call to action and paribelle.in; over a photo it turns solid for the last 2-3 s.",
  params: {
    cta: { type: "text", max: 24, doc: "Default \"Shop now\"." },
    url: { type: "text", max: 40, doc: "Default \"paribelle.in\"." },
    line: { type: "text", max: 60, doc: "A line under the wordmark: only something true of the brand or this product (from its data), or leave it out." },
    background: { type: "background", doc: "Default wine-deep; a photo of the product shows dimmed behind the card for its first 1-2 s, then the card turns solid wine for the last 2-3 s." },
  },
  build(p) {
    const bg = background(p.background, "wine-deep", 1.5);
    const t = tone(bg.dark);
    return {
      html: `${bg.html}${bg.photo ? `<div class="solid"></div>` : ""}
<div class="block">
  <div class="logo">${"PariBelle"
    .split("")
    .map((c) => `<span>${c}</span>`)
    .join("")}</div>
  <div class="rule"></div>
  ${str(p.line) ? `<div class="line">${esc(str(p.line))}</div>` : ""}
  <div class="cta">${esc(str(p.cta) || "Shop now")}</div>
  <div class="url">${esc(str(p.url) || "paribelle.in")}</div>
</div>`,
      css: `${bg.css}
.solid { position: absolute; inset: 0; opacity: 0; background: radial-gradient(120% 80% at 30% 20%, color-mix(in srgb, var(--wine-deep) 82%, white), var(--wine-deep) 55%, color-mix(in srgb, var(--wine-deep) 88%, black)); }
.block { ${SAFE_BOX} display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
.logo { font: 400 ${u(156)}/1 var(--font-logo); letter-spacing: .06em; color: ${t.head}; perspective: ${u(700)}; }
.logo span { display: inline-block; }
.rule { width: ${u(160)}; height: ${u(2)}; background: ${t.rule}; margin: ${u(44)} 0 ${u(34)}; }
.line { font: italic 400 ${u(50)}/1.2 var(--font-display); color: ${t.body}; margin-bottom: ${u(60)}; }
.cta { padding: ${u(30)} ${u(64)}; border: ${u(2)} solid ${t.rule}; font: 600 ${u(40)}/1 var(--font-text); letter-spacing: .2em; text-transform: uppercase; color: ${t.head}; }
.url { margin-top: ${u(30)}; font: 500 ${u(42)}/1 var(--font-text); letter-spacing: .14em; color: ${t.accent}; }`,
      // Over a photo, the owner wants the card fully opaque for its last 2-3 s: the photo fades out under solid wine.
      script: `${bg.photo ? `tl.fromTo(q(".bg"), { scale: 1.1 }, { scale: 1.02, duration: D, ease: "sine.out" }, 0);
const solid = Math.min(3, Math.max(2, D - 1.5));
tl.to(q(".solid"), { opacity: 1, duration: 0.5, ease: "sine.inOut" }, Math.max(0, D - solid - 0.5));` : `tl.fromTo(q(".bg"), { yPercent: -2 }, { yPercent: 2, duration: D, ease: "sine.inOut" }, 0);`}
tl.from(q(".logo span"), { opacity: 0, y: 50 * U, rotationX: -70, transformOrigin: "50% 100%", duration: 0.7 * K, ease: "expo.out", stagger: 0.035 * K }, 0.03);
tl.from(q(".rule"), { scaleX: 0, duration: 0.6 * K, ease: "power2.inOut" }, 0.4 * K);
tl.from(q(".line"), { opacity: 0, y: 20 * U, duration: 0.6 * K, ease: "power2.out" }, 0.5 * K);
tl.from(q(".cta"), { opacity: 0, y: 30 * U, duration: 0.6 * K, ease: "expo.out" }, 0.6 * K);
tl.from(q(".url"), { opacity: 0, duration: 0.5 * K }, 0.75 * K);
tl.to(q(".cta"), { backgroundColor: "${bg.dark ? "hsl(40 45% 80% / .14)" : "hsl(349 56% 89% / .8)"}", duration: 0.9, ease: "sine.inOut", yoyo: true, repeat: Math.max(0, Math.floor((D - 1.3 * K) / 0.9) - 1) }, 1.3 * K);
// It stays on screen 4-5 s, so it keeps moving: a slow push, and a gold glint running along the wordmark.
tl.fromTo(q(".block"), { scale: 1 }, { scale: 1.05, duration: D, ease: "none" }, 0);
for (let at = 1.4 * K; at + 0.8 < D; at += 1.6) tl.to(q(".logo span"), { color: "${bg.dark ? "hsl(40 60% 72%)" : "hsl(40 55% 45%)"}", duration: 0.18, ease: "sine.inOut", yoyo: true, repeat: 1, stagger: 0.04 }, at);`,
    };
  },
};

export const TEMPLATES: Record<string, Template> = Object.fromEntries(
  [hook, title, hero, beatsT, cutout, detail, price, swatches, sizes, split, quote, clip, endcard].map((t) => [t.name, t]),
);

/** A template's params for the model: what each is and whether it's needed. */
export function templateDocs() {
  return Object.values(TEMPLATES).map((t) => ({
    template: t.name,
    what: t.summary,
    params: Object.fromEntries(
      Object.entries(t.params).map(([k, p]) => [
        k,
        `${p.required ? "required " : ""}${p.type}${p.choices ? ` (${p.choices.join("|")})` : ""}${p.max !== undefined && (p.type === "text" || p.type === "list" || p.type === "medias") ? `, max ${p.max}` : ""}: ${p.doc}`,
      ]),
    ),
  }));
}

/** What's wrong with a scene's params for its template (empty when they're fine). */
export function checkParams(t: Template, params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(params)) if (!(k in t.params)) errors.push(`${t.name} has no param "${k}" (it takes ${Object.keys(t.params).join(", ")}).`);
  for (const [k, p] of Object.entries(t.params)) {
    const v = params[k];
    if (v === undefined || v === null || v === "") {
      if (p.required) errors.push(`${t.name} needs ${k}: ${p.doc}`);
      continue;
    }
    switch (p.type) {
      case "text":
        if (typeof v !== "string") errors.push(`${k} is text.`);
        else if (p.max && v.length > p.max) errors.push(`${k} is ${v.length} characters; at most ${p.max} reads on a phone.`);
        break;
      case "media":
        if (typeof v !== "string" || !isMedia(v)) errors.push(`${k} is a media ref (chat:<n>, asset:<id>, video:<id>, brand:endcard).`);
        break;
      case "medias":
      case "list": {
        const items = Array.isArray(v) ? v : null;
        if (!items) errors.push(`${k} is a list.`);
        else {
          if (p.type === "medias" && items.some((x) => typeof x !== "string" || !isMedia(x))) errors.push(`${k} holds media refs.`);
          if (p.max && items.length > p.max) errors.push(`${k} takes at most ${p.max}.`);
          if (p.min && items.length < p.min) errors.push(`${k} needs at least ${p.min}.`);
        }
        break;
      }
      case "numbers":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "number")) errors.push(`${k} is a list of numbers.`);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${k} is a number.`);
        else if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) errors.push(`${k} is between ${p.min ?? "-"} and ${p.max ?? "-"}.`);
        break;
      case "boolean":
        if (typeof v !== "boolean") errors.push(`${k} is true or false.`);
        break;
      case "choice":
        if (!p.choices?.includes(String(v))) errors.push(`${k} is one of ${p.choices?.join(", ")}.`);
        break;
      case "color":
      case "background":
        if (typeof v !== "string") errors.push(`${k} is a palette name, a CSS colour${p.type === "background" ? " or a photo ref" : ""}.`);
        else if (!PALETTE[v] && !/^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([^)]*\))$/i.test(v) && !(p.type === "background" && isMedia(v))) {
          errors.push(`${k} "${v}" isn't a palette name (${Object.keys(PALETTE).join(", ")}), a CSS colour${p.type === "background" ? " or a photo ref" : ""}.`);
        }
        break;
    }
  }
  return errors;
}
