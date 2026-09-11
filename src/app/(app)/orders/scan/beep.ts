/**
 * A short confirmation beep for a successful scan — a synthesized tone via
 * Web Audio, not an audio file, so there is nothing to fetch or ship. Mirrors
 * the chirp a dedicated barcode scanner makes, which is the whole point: the
 * packer is watching the parcel, not the screen, and needs to hear that a
 * code was actually read.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  // A browser suspends the context until a user gesture resumes it; a scan
  // is always in response to one (a tap, a key from a bench scanner), so
  // this just catches the rare case where it hasn't caught up yet.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function playScanBeep() {
  const audio = audioContext();
  if (!audio) return;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  osc.frequency.value = 1500;

  const now = audio.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}
