/**
 * Beat analysis for the reel song library. Pure DSP, no model: it runs once per
 * song when the song is added (scripts/reel-songs.ts) and its result is stored
 * next to the audio, so rendering only ever reads numbers.
 *
 * The pipeline is the classic one:
 *   1. an onset envelope — spectral flux of the log magnitude spectrum, with a
 *      separate low-band flux that follows the kick drum;
 *   2. tempo — autocorrelation of that envelope, weighted towards ~115 BPM so a
 *      double- or half-time reading loses to the one people dance to;
 *   3. beats — Ellis's dynamic programme (the one librosa uses): place beats on
 *      strong onsets while keeping the spacing close to the tempo;
 *   4. structure — which beat of four starts a bar (kick plus harmonic change),
 *      which bar of four starts a phrase, where the energy lifts, and the hook.
 *
 * Times are seconds. Every per-beat array is indexed like `beats`.
 */

export const SAMPLE_RATE = 22050;
const HOP = 512;
const N_FFT = 2048;
const FPS = SAMPLE_RATE / HOP;
const N_BANDS = 24;
const N_ONSET_BANDS = 48;
/**
 * A centred frame starts hearing a hit half a window before its centre, so the
 * flux peaks early. Measured on synthetic tracks with known beats: 20 ms early
 * at every tempo. Added back so a cut lands on the hit, not just before it.
 */
const ONSET_LAG = 0.02;

export interface TrackAnalysis {
  version: 1;
  duration: number;
  bpm: number;
  beats: number[];
  /** `beats[i]` starts a bar when `(i - downbeat) % 4 === 0`. */
  downbeat: number;
  /** How hard each beat hits, 0..1. */
  strength: number[];
  /** How loud the music is from this beat to the next, 0..1 across the song. */
  energy: number[];
  /** Beat indices where a four-bar phrase starts. */
  phrases: number[];
  /** Beat indices of bars where the music lifts: a drop, a chorus coming in. */
  lifts: number[];
  /** Seconds: where the part people know starts, if found or given. */
  hook: number | null;
}

/* -------------------------------------------------------------------------- */
/* Spectral features                                                          */
/* -------------------------------------------------------------------------- */

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

interface Features {
  frames: number;
  /** Full-band onset strength per frame, mean-removed and >= 0. */
  onset: Float32Array;
  /** Onset strength below ~150 Hz: the kick. */
  low: Float32Array;
  /** Frame loudness in dB. */
  db: Float32Array;
  /** `frames * N_BANDS` log band energies, for measuring harmonic change. */
  bands: Float32Array;
}

function features(samples: Float32Array): Features {
  // Centre the frames: frame t is centred on sample t * HOP.
  const pad = N_FFT / 2;
  const padded = new Float32Array(samples.length + N_FFT);
  padded.set(samples, pad);
  const frames = Math.max(1, Math.floor((padded.length - N_FFT) / HOP) + 1);

  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

  const bins = N_FFT / 2 + 1;
  const binHz = SAMPLE_RATE / N_FFT;

  // Log-spaced bands, like a mel scale: every band counts once in the flux, so
  // the kick and snare are not drowned out by the thousands of treble bins a
  // hi-hat lights up (which made the tracker lock onto the off-beats).
  const bandEdges = (count: number, from: number, to: number) => {
    const edges: number[] = [];
    for (let b = 0; b <= count; b++) edges.push(Math.max(1, Math.round((from * Math.pow(to / from, b / count)) / binHz)));
    for (let b = 1; b <= count; b++) edges[b] = Math.max(edges[b], edges[b - 1] + 1);
    return edges;
  };
  const onsetEdges = bandEdges(N_ONSET_BANDS, 30, 8000);
  const lowBands = onsetEdges.findIndex((e) => e * binHz >= 150);
  const edges = bandEdges(N_BANDS, 60, 8000);

  const onsetRaw = new Float32Array(frames);
  const low = new Float32Array(frames);
  const db = new Float32Array(frames);
  const bands = new Float32Array(frames * N_BANDS);

  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const mag = new Float64Array(bins);
  let prev = new Float64Array(N_ONSET_BANDS);
  let cur = new Float64Array(N_ONSET_BANDS);

  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    let sq = 0;
    for (let i = 0; i < N_FFT; i++) {
      const s = padded[off + i];
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    db[t] = 10 * Math.log10(sq / N_FFT + 1e-10);
    fft(re, im);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);

    for (let b = 0; b < N_ONSET_BANDS; b++) {
      let sum = 0;
      for (let k = onsetEdges[b]; k < onsetEdges[b + 1] && k < bins; k++) sum += mag[k] * mag[k];
      cur[b] = Math.log1p(10 * Math.sqrt(sum / (onsetEdges[b + 1] - onsetEdges[b])));
    }
    if (t > 0) {
      let flux = 0;
      let lowFlux = 0;
      for (let b = 0; b < N_ONSET_BANDS; b++) {
        const d = cur[b] - prev[b];
        if (d > 0) {
          flux += d;
          if (b < lowBands) lowFlux += d;
        }
      }
      onsetRaw[t] = flux;
      low[t] = lowFlux;
    }
    for (let b = 0; b < N_BANDS; b++) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1] && k < bins; k++) sum += Math.log1p(100 * mag[k]);
      bands[t * N_BANDS + b] = sum / (edges[b + 1] - edges[b]);
    }
    [prev, cur] = [cur, prev];
  }

  // Remove the slow trend so a loud chorus doesn't read as one long onset.
  const onset = new Float32Array(frames);
  const half = 8;
  let acc = 0;
  for (let t = 0; t < Math.min(frames, half); t++) acc += onsetRaw[t];
  for (let t = 0; t < frames; t++) {
    const add = t + half;
    const drop = t - half - 1;
    if (add < frames) acc += onsetRaw[add];
    if (drop >= 0) acc -= onsetRaw[drop];
    const n = Math.min(frames - 1, t + half) - Math.max(0, t - half) + 1;
    onset[t] = Math.max(0, onsetRaw[t] - acc / n);
  }
  const sd = Math.sqrt(onset.reduce((s, v) => s + v * v, 0) / frames) || 1;
  for (let t = 0; t < frames; t++) onset[t] /= sd;

  return { frames, onset, low, db, bands };
}

/* -------------------------------------------------------------------------- */
/* Tempo and beats                                                            */
/* -------------------------------------------------------------------------- */

/** Beat period in frames, from the onset envelope's autocorrelation. */
function estimatePeriod(onset: Float32Array): number {
  const minLag = Math.floor((FPS * 60) / 180);
  const maxLag = Math.ceil((FPS * 60) / 70);
  const n = Math.min(onset.length, Math.round(FPS * 150));
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += onset[t] * onset[t + lag];
    ac[lag] = s / Math.max(1, n - lag);
  }
  const score = (lag: number) => {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
    return prior * (ac[lag] + 0.5 * ac[Math.min(ac.length - 1, lag * 2)]);
  };
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score(lag) > score(best)) best = lag;

  // Parabolic refinement between neighbouring lags.
  const a = score(best - 1);
  const b = score(best);
  const c = score(best + 1);
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return best + shift;
}

/** Ellis (2007) dynamic-programming beat tracker. Returns beat frame indices. */
function trackBeats(onset: Float32Array, period: number): number[] {
  const n = onset.length;
  const tightness = 100;

  // Local score: onset smoothed by a Gaussian a fraction of a beat wide.
  const radius = Math.round(period);
  const kernel: number[] = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-0.5 * Math.pow((i * 32) / period, 2)));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = -radius; i <= radius; i++) {
      const j = t + i;
      if (j >= 0 && j < n) s += onset[j] * kernel[i + radius];
    }
    local[t] = s;
  }

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const s = cum[tau] - tightness * Math.pow(Math.log((t - tau) / period), 2);
      if (s > best) {
        best = s;
        arg = tau;
      }
    }
    cum[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }

  // The last beat: the latest local maximum of the cumulative score that is
  // at least half the median local maximum.
  const maxima: number[] = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t);
  if (maxima.length === 0) return [];
  const sorted = maxima.map((t) => cum[t]).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  let last = maxima[maxima.length - 1];
  for (let i = maxima.length - 1; i >= 0; i--) {
    if (cum[maxima[i]] >= 0.5 * median) {
      last = maxima[i];
      break;
    }
  }

  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // Trim the weak tails (fade-in, fade-out) where the tracker was guessing.
  const rms = Math.sqrt(local.reduce((s, v) => s + v * v, 0) / n);
  const thr = 0.5 * rms;
  let a = 0;
  let b = beats.length;
  while (a < b && local[beats[a]] < thr) a++;
  while (b > a && local[beats[b - 1]] < thr) b--;
  return beats.slice(a, b);
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

function quantile(values: ArrayLike<number>, q: number): number {
  const s = Array.from(values).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

function meanBands(f: Features, from: number, to: number): Float64Array {
  const out = new Float64Array(N_BANDS);
  const a = Math.max(0, from);
  const b = Math.min(f.frames, Math.max(a + 1, to));
  for (let t = a; t < b; t++) for (let k = 0; k < N_BANDS; k++) out[k] += f.bands[t * N_BANDS + k];
  for (let k = 0; k < N_BANDS; k++) out[k] /= b - a;
  return out;
}

function cosineDistance(x: Float64Array, y: Float64Array): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let k = 0; k < x.length; k++) {
    dot += x[k] * y[k];
    nx += x[k] * x[k];
    ny += y[k] * y[k];
  }
  return nx && ny ? 1 - dot / Math.sqrt(nx * ny) : 0;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

/**
 * Analyse mono PCM at `SAMPLE_RATE`. `hook`, when given, is the start of the
 * part the song is known for (a trending reel's snippet); otherwise the
 * loudest phrase after the intro is taken.
 */
export function analyseTrack(samples: Float32Array, opts: { hook?: number | null } = {}): TrackAnalysis {
  const f = features(samples);
  const duration = samples.length / SAMPLE_RATE;
  const period = estimatePeriod(f.onset);
  const beatFrames = trackBeats(f.onset, period);
  if (beatFrames.length < 16) throw new Error("Could not find a steady beat in this song.");

  const beats = beatFrames.map((t) => (t * HOP) / SAMPLE_RATE + ONSET_LAG);
  // Mean spacing over the whole run: a single gap is quantised to whole frames
  // (23 ms), which read 97 BPM as 95.7.
  const bpm = (60 * (beats.length - 1)) / (beats[beats.length - 1] - beats[0]);

  const n = beats.length;
  const next = (i: number) => (i + 1 < n ? beatFrames[i + 1] : Math.min(f.frames, beatFrames[i] + Math.round(period)));
  const prevF = (i: number) => (i > 0 ? beatFrames[i - 1] : Math.max(0, beatFrames[i] - Math.round(period)));
  const peak = (arr: Float32Array, t: number) => {
    let m = 0;
    for (let j = t - 2; j <= t + 2; j++) if (j >= 0 && j < arr.length) m = Math.max(m, arr[j]);
    return m;
  };

  // Per-beat strength, loudness, kick and harmonic change.
  const rawStrength = beatFrames.map((t) => peak(f.onset, t));
  const s95 = quantile(rawStrength, 0.95) || 1;
  const strength = rawStrength.map((v) => Math.min(1, v / s95));

  const beatDb = beatFrames.map((t, i) => {
    let s = 0;
    const end = Math.max(t + 1, next(i));
    for (let j = t; j < end && j < f.frames; j++) s += f.db[j];
    return s / Math.max(1, Math.min(end, f.frames) - t);
  });
  const lo = quantile(beatDb, 0.1);
  const hi = quantile(beatDb, 0.95);
  const energy = beatDb.map((v) => Math.max(0, Math.min(1, (v - lo) / Math.max(1e-6, hi - lo))));

  const kick = beatFrames.map((t) => peak(f.low, t));
  const k95 = quantile(kick, 0.95) || 1;
  const change = beatFrames.map((t, i) => cosineDistance(meanBands(f, prevF(i), t), meanBands(f, t, next(i))));
  const c95 = quantile(change, 0.95) || 1;

  // Which beat of four starts a bar: the kick lands on 1 (and 3), and chords
  // change on 1 — so 1 and 3 tie on the kick and the harmony breaks the tie.
  let downbeat = 0;
  let bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    const idx = beats.map((_, i) => i).filter((i) => i >= p && (i - p) % 4 === 0);
    const score = mean(idx.map((i) => kick[i] / k95)) + mean(idx.map((i) => change[i] / c95));
    if (score > bestPhase) {
      bestPhase = score;
      downbeat = p;
    }
  }

  // Bars, and which bar of four starts a phrase (the biggest harmonic turns).
  const barStarts: number[] = [];
  for (let i = downbeat; i + 4 <= n; i += 4) barStarts.push(i);
  const barEnergy = barStarts.map((i) => mean(energy.slice(i, i + 4)));
  const barChange = barStarts.map((i, b) =>
    b === 0 ? 0 : cosineDistance(meanBands(f, beatFrames[barStarts[b - 1]], beatFrames[i]), meanBands(f, beatFrames[i], next(i + 3))),
  );
  let phase = 0;
  let bestBar = -Infinity;
  for (let q = 0; q < 4; q++) {
    const score = mean(barChange.filter((_, b) => b % 4 === q));
    if (score > bestBar) {
      bestBar = score;
      phase = q;
    }
  }
  const phrases = barStarts.filter((_, b) => b % 4 === phase);

  const lifts = barStarts.filter((_, b) => {
    if (b < 2) return false;
    const before = (barEnergy[b - 1] + barEnergy[b - 2]) / 2;
    return barEnergy[b] - before > 0.12 && barEnergy[b] > 0.5;
  });

  let hook: number | null = opts.hook ?? null;
  if (hook == null) {
    let best = -Infinity;
    for (let b = 0; b < barStarts.length; b++) {
      const t = beats[barStarts[b]];
      if (t < 10 || t > duration - 30) continue;
      const ahead = barEnergy.slice(b, b + 8);
      if (ahead.length < 8) continue;
      const before = b >= 2 ? (barEnergy[b - 1] + barEnergy[b - 2]) / 2 : barEnergy[b];
      const score = mean(ahead) + 0.6 * Math.max(0, barEnergy[b] - before) + (phrases.includes(barStarts[b]) ? 0.15 : 0);
      if (score > best) {
        best = score;
        hook = t;
      }
    }
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    version: 1,
    duration: round(duration),
    bpm: Math.round(bpm * 10) / 10,
    beats: beats.map(round),
    downbeat,
    strength: strength.map((v) => Math.round(v * 100) / 100),
    energy: energy.map((v) => Math.round(v * 100) / 100),
    phrases,
    lifts,
    hook: hook == null ? null : round(hook),
  };
}

/**
 * The analysis of `[from, to)` seconds, re-based so that `from` is 0 — what is
 * stored for the clipped stretch of a song. Slicing beats the tracker running
 * again on the clip, which would be guessing at both cut edges.
 */
export function sliceAnalysis(a: TrackAnalysis, from: number, to: number): TrackAnalysis {
  const keep = a.beats.map((t, i) => [t, i] as const).filter(([t]) => t >= from && t < to - 0.05);
  if (keep.length < 16) throw new Error("That stretch of the song is too short to use.");
  const first = keep[0][1];
  const lastIdx = keep[keep.length - 1][1];
  const shift = (list: number[]) => list.filter((i) => i >= first && i <= lastIdx).map((i) => i - first);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    version: 1,
    duration: round(to - from),
    bpm: a.bpm,
    beats: keep.map(([t]) => round(t - from)),
    downbeat: (((a.downbeat - first) % 4) + 4) % 4,
    strength: a.strength.slice(first, lastIdx + 1),
    energy: a.energy.slice(first, lastIdx + 1),
    phrases: shift(a.phrases),
    lifts: shift(a.lifts),
    hook: a.hook == null ? null : round(Math.max(0, a.hook - from)),
  };
}

export const isDownbeat = (a: TrackAnalysis, i: number) => i >= a.downbeat && (i - a.downbeat) % 4 === 0;
