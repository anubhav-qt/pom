/**
 * Voice input's sound handling, apart from React and the browser so it can be tested:
 * the microphone's samples brought down to 16 kHz mono, kept until the person is done,
 * and packed as WAV for Gemini.
 */

export const RATE = 16_000;
/** 20 ms, the step the sound wave is measured in. */
const FRAME = RATE / 50;

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

/** The recording so far (16 kHz), and how loud each 20 ms of it was. */
export class Recording {
  private chunks: Float32Array[] = [];
  private length = 0;
  private pending = new Float32Array(0);
  private rms: number[] = [];

  get samples() {
    return this.length;
  }

  push(input: Float32Array) {
    this.chunks.push(input);
    this.length += input.length;
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    let at = 0;
    for (; at + FRAME <= joined.length; at += FRAME) {
      let sum = 0;
      for (let i = at; i < at + FRAME; i++) sum += joined[i] * joined[i];
      this.rms.push(Math.sqrt(sum / FRAME));
    }
    this.pending = joined.slice(at);
  }

  /** The latest `n` loudness readings, 0 to 1, for the sound wave. */
  levels(n: number): number[] {
    return this.rms.slice(-n).map((r) => Math.min(1, Math.sqrt(r) * 3.2));
  }

  /** Whether anything louder than room noise was said. */
  heardSpeech() {
    let loud = 0;
    for (const r of this.rms) if (r > 0.012 && ++loud >= 15) return true;
    return false;
  }

  /** Every sample so far, in one piece. */
  all(): Float32Array {
    const out = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
