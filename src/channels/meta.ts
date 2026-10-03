/**
 * Each channel's name and colour, for the UI. Kept apart from the adapters
 * (channels/index.ts) so client screens can read it without pulling in
 * server-only code.
 */
export const CHANNEL_META = {
  amazon: { name: "Amazon", color: "#ff9900", live: true },
  flipkart: { name: "Flipkart", color: "#2874f0", live: true },
  meesho: { name: "Meesho", color: "#f43397", live: false },
  paribelle: { name: "paribelle.in", color: "#b8456b", live: true },
} as const;
