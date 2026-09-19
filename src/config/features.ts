/**
 * Feature switches.
 *
 * The app is being narrowed to one job for now: pull everything Amazon will
 * give us and keep it. The dispatch-floor features (barcode scanning, label
 * printing, manifests) and the other two channels are switched off here rather
 * than deleted — the code is tested and working, and turning any of it back on
 * is a one-line change.
 *
 * Nothing here is a security boundary. Disabled routes redirect rather than
 * 404, and disabled channels are hidden from the UI; the adapters themselves
 * are untouched.
 */
export const FEATURES = {
  /** Barcode scanning bench at /pack. */
  packStation: false,

  /** Label PDF generation, cropping, and courier manifests. */
  labelPrinting: false,

  /** Manual stock editing and pushing stock out to channels. */
  inventoryManagement: false,

  /** Returns desk: customer returns, RTO and cancelled parcels, check-in and claims. */
  returns: true,

  /** Meesho order-sheet and label upload form in Settings. */
  meeshoImport: false,

  /**
   * TOTP two-factor login. Turned off at the owner's explicit request
   * (2026-08-08) — flagged once at the time that this is one of the three
   * controls attested to Amazon on the SP-API developer profile, so turning
   * it off means the running app no longer matches that submission. Kept as
   * a flag rather than removed so it is a one-line change to restore.
   */
  requireMfa: false,
} as const;

/**
 * Channels offered in the UI. The adapters for the others still exist and still
 * work — they are simply not presented until we get to them.
 */
export const ENABLED_CHANNELS = ["amazon"] as const;

export type EnabledChannel = (typeof ENABLED_CHANNELS)[number];

export function isChannelEnabled(channel: string): boolean {
  return (ENABLED_CHANNELS as readonly string[]).includes(channel);
}
