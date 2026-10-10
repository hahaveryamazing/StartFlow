import { create } from 'zustand';
import type { Settings } from '../../types';
import type { Theme } from '../../types/v2';

export const useAppearancePreview = create<{
  preview: { settings: Settings; theme: Theme } | null;
  setPreview: (preview: { settings: Settings; theme: Theme } | null) => void;
}>((set) => ({ preview: null, setPreview: (preview) => set({ preview }) }));
