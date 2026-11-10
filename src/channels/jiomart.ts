import type { ChannelAccount } from "@/db/schema";

import {
  NotSupportedError,
  type CanonicalReturn,
  type ChannelAdapter,
  type FetchOrdersOptions,
  type FetchOrdersResult,
  type InventoryPushResult,
  type InventoryUpdate,
  type LabelResult,
} from "./types";

/**
 * JioMart has no self-serve seller API: its seller panel is the only door, and
 * integrations go through Jio's onboarded partners (Fynd Konnect, Unicommerce).
 * Until JioMart grants us API access, its orders, returns and payments are read
 * off the seller panel like Flipkart's and Meesho's (docs/portals/procedure.md),
 * and Finance and Seelie count them.
 *
 * It implements the same ChannelAdapter interface as the live channels so that,
 * once credentials exist, only this file changes.
 */
export class JiomartAdapter implements ChannelAdapter {
  readonly channel = "jiomart" as const;
  readonly supportsLiveSync = false;
  readonly supportsInventoryPush = false;
  readonly supportsLabelFetch = false;

  constructor(private account: ChannelAccount) {}

  async fetchOrders(_opts: FetchOrdersOptions): Promise<FetchOrdersResult> {
    throw new NotSupportedError("jiomart", "live order sync");
  }

  async fetchReturns(_opts: FetchOrdersOptions): Promise<{ returns: CanonicalReturn[]; syncedThrough: Date }> {
    throw new NotSupportedError("jiomart", "live return sync");
  }

  async fetchLabels(_ids: string[]): Promise<LabelResult[]> {
    throw new NotSupportedError("jiomart", "label fetch");
  }

  async pushInventory(_updates: InventoryUpdate[]): Promise<InventoryPushResult[]> {
    throw new NotSupportedError("jiomart", "inventory push");
  }
}
