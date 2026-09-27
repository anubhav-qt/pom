/**
 * The transitions a photo reel can use between two photos. The frames
 * themselves never move (no zooms, no pans): every transition happens in
 * place, on the picture, and is centred on the beat the cut sits on.
 *
 * One list for everyone: the renderer draws these, Gemini chooses from them
 * (by `id`, reading `about`), and the Reels screen names them. No imports, so
 * a client component can use it.
 */

export const TRANSITIONS = [
  {
    id: "cut",
    label: "Cut",
    about: "A clean cut exactly on the beat. Confident, the backbone of a good edit; use it most.",
    seconds: 0,
  },
  {
    id: "dissolve",
    label: "Dissolve",
    about: "A soft cross-dissolve. Graceful; for calm moments and between shots of the same outfit.",
    seconds: 0.55,
  },
  {
    id: "dip_black",
    label: "Dip to black",
    about: "Fades through deep black and back. Elegant; marks a new outfit or a new section of the song.",
    seconds: 0.7,
  },
  {
    id: "dip_ivory",
    label: "Dip to ivory",
    about: "Fades through warm ivory light and back. Airy and bridal; for pastels, whites and festive looks.",
    seconds: 0.7,
  },
  {
    id: "light_leak",
    label: "Light leak",
    about: "A warm amber and rose film light leak washes across; the photo changes under its glow. Dreamy; for a lift in the music.",
    seconds: 0.8,
  },
  {
    id: "chroma",
    label: "Chroma split",
    about: "The colours split into red, green and blue for an instant as the photo changes. Editorial; for a strong beat.",
    seconds: 0.36,
  },
  {
    id: "grain",
    label: "Film grain",
    about: "Film grain, dust and a flicker of exposure over the cut, like old film stock. Textured and grungy; use sparingly.",
    seconds: 0.5,
  },
  {
    id: "ripple",
    label: "Ripple",
    about: "The picture ripples in place like heat haze or silk in a breeze, and settles into the next. Fluid; for flowing fabrics.",
    seconds: 0.65,
  },
  {
    id: "focus",
    label: "Focus pull",
    about: "The photo drifts out of focus and the next one comes into focus. Soft and cinematic; into a close-up or out of one.",
    seconds: 0.6,
  },
  {
    id: "silk_wipe",
    label: "Silk wipe",
    about: "The next photo slides in behind a soft diagonal edge with a faint sheen, like silk drawn across. For a new angle of the same outfit.",
    seconds: 0.6,
  },
  {
    id: "glow",
    label: "Glow",
    about: "The highlights bloom into a soft glow and the next photo emerges from it. Luxurious; for the hero shot or the last look.",
    seconds: 0.7,
  },
] as const;

export type TransitionId = (typeof TRANSITIONS)[number]["id"];

export const TRANSITION_IDS = TRANSITIONS.map((t) => t.id) as TransitionId[];

const BY_ID = new Map<string, (typeof TRANSITIONS)[number]>(TRANSITIONS.map((t) => [t.id, t]));

export const isTransition = (v: unknown): v is TransitionId => typeof v === "string" && BY_ID.has(v);

export const transitionLabel = (id: string) => BY_ID.get(id)?.label ?? id;

/** How long a transition takes, centred on its cut, before it is fitted to the shots either side. */
export const transitionSeconds = (id: TransitionId) => BY_ID.get(id)?.seconds ?? 0;
