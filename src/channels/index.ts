import type { ChannelAccount } from "@/db/schema";

import { AmazonAdapter } from "./amazon";
import { FlipkartAdapter } from "./flipkart";
import { MeeshoAdapter } from "./meesho";
import type { ChannelAdapter } from "./types";

export function adapterFor(account: ChannelAccount): ChannelAdapter {
  switch (account.channel) {
    case "amazon":
      return new AmazonAdapter(account);
    case "flipkart":
      return new FlipkartAdapter(account);
    case "meesho":
      return new MeeshoAdapter(account);
  }
}

export const CHANNEL_META = {
  amazon: { name: "Amazon", color: "#ff9900", live: true },
  flipkart: { name: "Flipkart", color: "#2874f0", live: true },
  meesho: { name: "Meesho", color: "#f43397", live: false },
} as const;

export * from "./types";
export { parseMeeshoOrderSheet, splitMeeshoLabels } from "./meesho";
