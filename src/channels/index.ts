import type { ChannelAccount } from "@/db/schema";

import { AmazonAdapter } from "./amazon";
import { FlipkartAdapter } from "./flipkart";
import { MeeshoAdapter } from "./meesho";
import { ParibelleAdapter } from "./paribelle";
import type { ChannelAdapter } from "./types";

export function adapterFor(account: ChannelAccount): ChannelAdapter {
  switch (account.channel) {
    case "amazon":
      return new AmazonAdapter(account);
    case "flipkart":
      return new FlipkartAdapter(account);
    case "meesho":
      return new MeeshoAdapter(account);
    case "paribelle":
      return new ParibelleAdapter(account);
  }
}

export { CHANNEL_META } from "./meta";
export * from "./types";
export { parseMeeshoOrderSheet, splitMeeshoLabels } from "./meesho";
