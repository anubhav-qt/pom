/**
 * Voice input's sound handling, apart from React and the browser so it can be tested:
 * the microphone's samples brought down to 16 kHz mono, cut into pieces at the speaker's
 * pauses (so no word is split between two pieces), and packed as WAV for Gemini.
 */

export const RATE = 16_000;
/** 20 ms, the step the pause finder works in. */
export const FRAME = RATE / 50;

/** A pause this long ends a piece. */
const PAUSE_MS = 600;
/** Speech kept after the last loud frame, so a soft last syllable isn't cut. */
const TAIL_MS = 200;
/** A piece needs this much speech; less is a cough or a click. */
const MIN_SPEECH_MS = 300;
/** A piece with no pause in it is cut here anyway, at its quietest moment near the end. */
const MAX_PIECE_MS = 15_000;
/** Where in the last few seconds that cut looks for the quietest frame. */
const SEARCH_MS = 3_000;
/** Silence before speech starts is dropped, all but this much lead-in. */
const LEAD_MS = 300;

const ms = (n: number) => Math.round((n / 1000) * RATE);
const frames = (n: number) => Math.round(n / 20);

/** `input` at `from` Hz, as 16 kHz: each output sample averages the input it spans. */
export function downsample(input: Float32Array, from: number): Float32Array {
  if (from === RATE) return input.slice();
  const ratio = from / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/** 16 kHz mono samples as a 16-bit WAV file. */
export function wav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** A finished piece: samples [from, to) of the recording. */
export type Cut = { from: number; to: number };

/**
 * The recording so far and where it is cut. `push` takes 16 kHz samples and returns
 * the pieces that just ended; `open` is the piece still being spoken; `finish` ends it.
 */
export class Pieces {
  private chunks: Float32Array[] = [];
  private length = 0;
  private pending = new Float32Array(0);
  /** Loudness of each 20 ms frame so far. */
  private rms: number[] = [];
  /** The room's noise, learnt as it goes. */
  private floor = 0.005;
  private start = 0;
  private speechFrames = 0;
  private lastLoud = -1;

  get samples() {
    return this.length;
  }

  /** The latest loudness, 0 to 1, for the sound wave. */
  levels(n: number): number[] {
    return this.rms.slice(-n).map((r) => Math.min(1, Math.sqrt(r) * 3.2));
  }

  /** The piece still being spoken, once it holds enough speech to send. */
  open(): Cut | null {
    return this.speechFrames >= frames(MIN_SPEECH_MS) ? { from: this.start, to: this.processed() } : null;
  }

  push(input: Float32Array): Cut[] {
    this.chunks.push(input);
    this.length += input.length;
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    const cuts: Cut[] = [];
    let at = 0;
    for (; at + FRAME <= joined.length; at += FRAME) {
      const cut = this.frame(joined.subarray(at, at + FRAME));
      if (cut) cuts.push(cut);
    }
    this.pending = joined.slice(at);
    return cuts;
  }

  /** Ends the recording: the last piece, if it holds speech. */
  finish(): Cut | null {
    const end = this.length;
    const cut = this.speechFrames >= frames(MIN_SPEECH_MS) ? { from: this.start, to: end } : null;
    this.start = end;
    this.speechFrames = 0;
    return cut;
  }

  /** Samples [from, to) of the recording. */
  slice(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    let offset = 0;
    for (const chunk of this.chunks) {
      const a = Math.max(from, offset);
      const b = Math.min(to, offset + chunk.length);
      if (a < b) out.set(chunk.subarray(a - offset, b - offset), a - from);
      offset += chunk.length;
      if (offset >= to) break;
    }
    return out;
  }

  private processed() {
    return this.rms.length * FRAME;
  }

  private frame(samples: Float32Array): Cut | null {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const index = this.rms.length;
    this.rms.push(rms);
    // The floor drops fast to quiet frames and creeps up slowly, so speech never becomes it.
    this.floor = rms < this.floor ? this.floor * 0.8 + rms * 0.2 : Math.min(0.05, this.floor * 1.003 + 1e-6);
    const loud = rms > Math.max(0.012, this.floor * 3);
    const end = (index + 1) * FRAME;

    if (loud) {
      // Speech after a stretch of silence: start the piece just before it.
      if (this.speechFrames === 0) this.start = Math.max(this.start, index * FRAME - ms(LEAD_MS));
      this.speechFrames++;
      this.lastLoud = index;
    }

    if (this.speechFrames === 0) return null;

    const quietFor = (index - this.lastLoud) * 20;
    if (quietFor >= PAUSE_MS) {
      if (this.speechFrames < frames(MIN_SPEECH_MS)) {
        // A click or a cough, not speech.
        this.speechFrames = 0;
        return null;
      }
      const to = Math.min(end, (this.lastLoud + 1) * FRAME + ms(TAIL_MS));
      return this.cutAt(to);
    }

    if (end - this.start >= ms(MAX_PIECE_MS)) {
      const first = Math.max(this.start / FRAME, index - frames(SEARCH_MS));
      let quietest = index;
      for (let i = index; i >= first; i--) if (this.rms[i] < this.rms[quietest]) quietest = i;
      return this.cutAt((quietest + 1) * FRAME);
    }
    return null;
  }

  private cutAt(to: number): Cut {
    const cut = { from: this.start, to };
    this.start = to;
    this.speechFrames = 0;
    // Frames after the cut that were already loud start the next piece.
    for (let i = Math.ceil(to / FRAME); i < this.rms.length; i++) {
      if (this.rms[i] > Math.max(0.012, this.floor * 3)) {
        this.speechFrames++;
        this.lastLoud = i;
      }
    }
    return cut;
  }
}

/** The pieces' words in order, spaced. */
export function joinWords(parts: string[]) {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}
