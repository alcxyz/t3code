import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface ThreadTitleUpdatesPanelState {
  readonly open: boolean;
  readonly threadRef: ScopedThreadRef | null;
  readonly openThreadTitleUpdates: (threadRef: ScopedThreadRef) => void;
  readonly closeThreadTitleUpdates: () => void;
  readonly completeClose: () => void;
}

export const useThreadTitleUpdatesPanelStore = create<ThreadTitleUpdatesPanelState>((set) => ({
  open: false,
  threadRef: null,
  openThreadTitleUpdates: (threadRef) => set({ threadRef, open: true }),
  closeThreadTitleUpdates: () => set({ open: false }),
  completeClose: () => set((state) => (state.open ? state : { threadRef: null })),
}));

export function openThreadTitleUpdates(threadRef: ScopedThreadRef): void {
  useThreadTitleUpdatesPanelStore.getState().openThreadTitleUpdates(threadRef);
}

export function closeThreadTitleUpdates(): void {
  useThreadTitleUpdatesPanelStore.getState().closeThreadTitleUpdates();
}
