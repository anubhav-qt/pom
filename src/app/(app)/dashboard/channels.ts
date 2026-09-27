/**
 * Which marketplaces Finance counts. Pure data, no imports, so client
 * components can use it (the same reason as range.ts).
 *
 * Amazon's money comes from its Finances API; Flipkart's and Meesho's from
 * the reports downloaded off their seller portals (docs/portals/procedure.md).
 * All three land in the same tables, so Finance adds them up or shows one.
 */
export const MARKETPLACES = ["amazon", "flipkart", "meesho"] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

/** A marketplace, or every one of them together. */
export type FinanceChannel = "all" | Marketplace;

export const DEFAULT_CHANNEL: FinanceChannel = "all";

export const CHANNEL_LABEL: Record<FinanceChannel, string> = {
  all: "All marketplaces",
  amazon: "Amazon",
  flipkart: "Flipkart",
  meesho: "Meesho",
};

export function isFinanceChannel(v: string | undefined | null): v is FinanceChannel {
  return v === "all" || (MARKETPLACES as readonly string[]).includes(v ?? "");
}

/** The marketplaces a selection covers. */
export function marketplacesOf(channel: FinanceChannel): Marketplace[] {
  return channel === "all" ? [...MARKETPLACES] : [channel];
}

/**
 * The word in front of "net", "fees" and "profit": the marketplace's name, or
 * "Marketplace" when they are counted together ("Marketplace net").
 */
export function payerWord(channel: FinanceChannel): string {
  return channel === "all" ? "Marketplace" : CHANNEL_LABEL[channel];
}
