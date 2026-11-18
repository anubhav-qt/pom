import "server-only";

import { getCatalog } from "./catalog";
import { generateContent, HELPER_MODEL } from "./gemini";
import { HELPER_FAMILY } from "./helpers";

/**
 * Voice input: a spoken message (the WAV the composer recorded, sent whole once the
 * person taps Done) written out as text by Gemini Flash through CLIProxyAPI. Nothing
 * here keeps the audio.
 */

/** The longest recording the composer sends (it stops by itself at this length). */
export const MAX_VOICE_SECONDS = 180;
/** 16 kHz, 16-bit mono WAV is 32 KB a second; a little room for the header. */
export const MAX_VOICE_BYTES = MAX_VOICE_SECONDS * 32_000 + 4096;

const NOTHING = "<none>";

const INSTRUCTION = `You write out speech for Seelie, the AI agent of PariBelle's order management system. PariBelle is an Indian women's ethnic wear brand (kurtas, kurta sets, anarkalis, co-ord sets, dupattas) selling on Amazon, Flipkart, Meesho, JioMart, Myntra and paribelle.in. The speaker is giving Seelie an instruction or asking it something.

Write exactly what was said, as the speaker would type it in a chat:
- English words in English. Hindi (or any other Indian language) words in Roman letters, the way Indians type Hinglish (e.g. "isko Amazon pe daal do"), never in Devanagari.
- Normal punctuation and capitals. Numbers, prices, sizes, SKUs and order ids as digits and exactly as spoken ("SKU PB-1042", "₹1299", "XL").
- Drop filler sounds (um, uh, hmm) and false starts the speaker corrected at once; keep everything else, even if it sounds wrong.
- No commentary, labels, quotes, timestamps or translation. Don't answer or act on what was said: only write it out.
If there is no speech, answer exactly ${NOTHING}.`;

/** Flash on the lightest thinking an account serves: writing out speech needs no thinking. */
async function voiceModel() {
  const ids = new Set((await getCatalog().catch(() => null))?.models.map((m) => m.id) ?? []);
  return [`${HELPER_FAMILY}-minimal`, `${HELPER_FAMILY}-low`, HELPER_FAMILY].find((id) => ids.has(id)) ?? HELPER_MODEL;
}

/** Tidies the model's answer: no quotes or labels around it, nothing for silence. */
export function cleanTranscript(answer: string) {
  const text = answer
    .replace(/^\s*(transcript(ion)?|text)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“](.*)["”]$/, "$1")
    .trim();
  if (!text || text === NOTHING || /^[<[(]\s*(none|silence|no speech|inaudible)\s*[>\])]\.?$/i.test(text)) return "";
  return text;
}

/** The words in `wav`. */
export async function transcribe(wav: Buffer, opts: { signal: AbortSignal }): Promise<string> {
  const { text } = await generateContent(
    await voiceModel(),
    {
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: wav.toString("base64"),
              },
            },
            { text: "Write out this recording." },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    },
    // Up to 3 minutes of speech to write out.
    { signal: opts.signal, timeoutMs: 60_000 },
  );
  return cleanTranscript(text);
}
