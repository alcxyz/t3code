import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface ThreadTitleUpdatesPanelState {
  readonly threadRef: ScopedThreadRef | null;
  readonly openThreadTitleUpdates: (threadRef: ScopedThreadRef) => void;
  readonly closeThreadTitleUpdates: () => void;
}

export const useThreadTitleUpdatesPanelStore = create<ThreadTitleUpdatesPanelState>((set) => ({
  threadRef: null,
  openThreadTitleUpdates: (threadRef) => set({ threadRef }),
  closeThreadTitleUpdates: () => set({ threadRef: null }),
}));

export function openThreadTitleUpdates(threadRef: ScopedThreadRef): void {
  useThreadTitleUpdatesPanelStore.getState().openThreadTitleUpdates(threadRef);
}

export function closeThreadTitleUpdates(): void {
  useThreadTitleUpdatesPanelStore.getState().closeThreadTitleUpdates();
}
