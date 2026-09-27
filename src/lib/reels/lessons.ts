/**
 * What the owner's "Do you like this reel?" answers have taught the reel
 * director so far, and the version of the prompt that carries them. This is
 * the file docs/reels/feedback.md changes; select.ts builds the prompt.
 *
 * Plain data, no server imports, so scripts/reel-feedback.ts can read it too.
 */

/**
 * Which version of the directing prompt made a reel. Every answer records it,
 * so a change is judged by the answers that came after it. Bump it whenever
 * LESSONS or the prompt in select.ts change, and log why in docs/reels/feedback.md.
 */
export const PROMPT_VERSION = "2026-09-27.1";

/**
 * House rules, one short sentence each, in the voice of the prompt ("Open on
 * a full-length front shot."). They go into the prompt after the general
 * direction and win where the two disagree.
 */
export const LESSONS: string[] = [];
