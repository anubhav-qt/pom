"use client";

import { create } from "zustand";

/**
 * Whether the AI assistant panel is open. Pulled out of `ChatWidget`'s own
 * state so other entry points — the mobile bottom nav's "AI" tab — can open
 * it without threading a prop through the whole page tree.
 */
interface AssistantUiState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAssistantUi = create<AssistantUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
