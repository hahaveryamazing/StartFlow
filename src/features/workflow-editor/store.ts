import { create } from 'zustand';
import type { Workflow } from '../../types/v2';
interface EditorState {
  workflow: Workflow | null;
  saved: string;
  past: Workflow[];
  future: Workflow[];
  selected: string | null;
  open: (w: Workflow, saved?: boolean) => void;
  change: (w: Workflow, checkpoint?: boolean) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  select: (id: string | null) => void;
  close: () => void;
}
export const useEditor = create<EditorState>((set, get) => ({
  workflow: null,
  saved: '',
  past: [],
  future: [],
  selected: null,
  open: (w, saved = true) =>
    set({
      workflow: structuredClone(w),
      saved: saved ? JSON.stringify(w) : '',
      past: [],
      future: [],
      selected: null,
    }),
  change: (w, checkpoint = true) =>
    set((s) => ({
      workflow: w,
      past: checkpoint && s.workflow ? [...s.past.slice(-49), structuredClone(s.workflow)] : s.past,
      future: checkpoint ? [] : s.future,
    })),
  checkpoint: () =>
    set((s) => ({
      past: s.workflow ? [...s.past.slice(-49), structuredClone(s.workflow)] : s.past,
      future: [],
    })),
  undo: () => {
    const s = get();
    if (s.workflow && s.past.length)
      set({
        workflow: s.past[s.past.length - 1],
        past: s.past.slice(0, -1),
        future: [s.workflow, ...s.future].slice(0, 50),
      });
  },
  redo: () => {
    const s = get();
    if (s.workflow && s.future.length)
      set({
        workflow: s.future[0],
        future: s.future.slice(1),
        past: [...s.past, s.workflow].slice(-50),
      });
  },
  markSaved: () => set((s) => ({ saved: JSON.stringify(s.workflow) })),
  select: (selected) => set({ selected }),
  close: () => set({ workflow: null, past: [], future: [], selected: null, saved: '' }),
}));
